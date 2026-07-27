// Ingesta de una liquidación de motorizado: escribe la liquidación y sus líneas,
// y vincula cada línea con su pedido. La lectura del archivo (Excel/CSV o foto)
// ocurre antes, en lib/settlement-sheet.ts y lib/settlement-vision.ts; aquí
// llegan ya como `ParsedSettlementLine`, vengan de donde vengan. Una sola
// ingesta para los dos caminos.
//
// El vínculo se busca en este orden, del identificador más fuerte al más débil:
//
//   1. LA GUÍA. Es lo que el motorizado tiene delante cuando escribe la hoja, y
//      lo que el courier imprime en el paquete. Se busca en `shipments`, que ya
//      es la tabla que relaciona guía y pedido.
//   2. EL Nº DE PEDIDO, con el mismo emparejador que los reportes de courier
//      (lib/shipment-match.ts), incluida su validación por teléfono.
//   3. NADA. La línea queda en `match_status = 'review'` y la resuelve una
//      persona. No se adivina: vincular mal una línea mueve plata de un pedido a
//      otro y el cuadre deja de significar nada.

import type { SupabaseClient } from "@supabase/supabase-js";
import { chunk } from "@/lib/access";
import { normalizeOrderName } from "@/lib/aliclik-import";
import { matchShipment, type OrderCandidate } from "@/lib/shipment-match";
import type { ParsedSettlementLine } from "@/lib/settlement-sheet";

export interface IngestSettlementParams {
  orgId: string;
  storeId: string;
  /** Tiendas que puede tocar quien sube el archivo: una guía puede resolver a
   *  otra tienda de la misma organización, pero nunca fuera de su alcance. */
  accessibleStoreIds: string[];
  settlementDate: string; // YYYY-MM-DD
  source: "foto" | "hoja" | "manual";
  riderId: string | null;
  riderNameRaw: string | null;
  declaredCash: number;
  declaredYape: number;
  filePath: string | null;
  fileSha256: string | null;
  note: string | null;
  userId: string | null;
  lines: readonly ParsedSettlementLine[];
}

export interface IngestSettlementResult {
  settlementId: string | null;
  inserted: number;
  linked: number;
  review: number;
  /** Se subió un archivo que ya estaba cargado; no se duplica. */
  duplicate: boolean;
  duplicateOf: string | null;
  errors: string[];
}

/** Guía → pedido, leyendo `shipments`. Es el vínculo más fiable que hay. */
async function fetchGuideLinks(
  admin: SupabaseClient,
  storeIds: string[],
  guides: string[],
): Promise<Map<string, { orderId: string | null; storeId: string }>> {
  const out = new Map<string, { orderId: string | null; storeId: string }>();
  if (!storeIds.length || !guides.length) return out;
  for (const batch of chunk(guides, 200)) {
    const { data } = await admin
      .from("shipments")
      .select("guide_code,order_id,store_id")
      .in("store_id", storeIds)
      .in("guide_code", batch);
    for (const row of (data ?? []) as {
      guide_code: string | null;
      order_id: string | null;
      store_id: string;
    }[]) {
      if (!row.guide_code) continue;
      const key = row.guide_code.trim().toLowerCase();
      // Gana la primera guía con pedido: una guía repetida sin vínculo no debe
      // pisar a la misma guía ya vinculada.
      const prev = out.get(key);
      if (!prev || (!prev.orderId && row.order_id)) {
        out.set(key, { orderId: row.order_id, storeId: row.store_id });
      }
    }
  }
  return out;
}

async function fetchOrderCandidates(
  admin: SupabaseClient,
  storeIds: string[],
  names: string[],
): Promise<OrderCandidate[]> {
  if (!storeIds.length || !names.length) return [];
  const out: OrderCandidate[] = [];
  const seen = new Set<string>();
  for (const batch of chunk(names, 200)) {
    const { data } = await admin
      .from("orders")
      .select("id,store_id,name,customer_phone")
      .in("store_id", storeIds)
      .in("name", batch);
    for (const r of (data ?? []) as OrderCandidate[]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        out.push(r);
      }
    }
  }
  return out;
}

/**
 * Guarda la liquidación y sus líneas. Idempotente por `file_sha256`: volver a
 * subir el mismo archivo devuelve la liquidación que ya existe en vez de
 * duplicar la plata del día, que es el error más fácil de cometer.
 */
export async function ingestSettlement(
  admin: SupabaseClient,
  params: IngestSettlementParams,
): Promise<IngestSettlementResult> {
  const result: IngestSettlementResult = {
    settlementId: null,
    inserted: 0,
    linked: 0,
    review: 0,
    duplicate: false,
    duplicateOf: null,
    errors: [],
  };

  if (params.fileSha256) {
    const { data: dup } = await admin
      .from("rider_settlements")
      .select("id")
      .eq("org_id", params.orgId)
      .eq("file_sha256", params.fileSha256)
      .maybeSingle();
    if (dup?.id) {
      result.duplicate = true;
      result.duplicateOf = dup.id as string;
      result.settlementId = dup.id as string;
      return result;
    }
  }

  const { data: created, error: createErr } = await admin
    .from("rider_settlements")
    .insert({
      org_id: params.orgId,
      store_id: params.storeId,
      rider_id: params.riderId,
      rider_name_raw: params.riderNameRaw,
      settlement_date: params.settlementDate,
      source: params.source,
      file_path: params.filePath,
      file_sha256: params.fileSha256,
      declared_cash: params.declaredCash,
      declared_yape: params.declaredYape,
      note: params.note,
      created_by: params.userId,
    })
    .select("id")
    .single();
  if (createErr || !created?.id) {
    result.errors.push(createErr?.message ?? "no se pudo crear la liquidación");
    return result;
  }
  const settlementId = created.id as string;
  result.settlementId = settlementId;

  // El alcance de búsqueda incluye siempre la tienda de la liquidación.
  const storeIds = [...new Set([params.storeId, ...params.accessibleStoreIds])];

  const guides = [
    ...new Set(
      params.lines
        .map((l) => l.guide_code?.trim())
        .filter((v): v is string => Boolean(v)),
    ),
  ];
  const names = [
    ...new Set(
      params.lines
        .map((l) => normalizeOrderName(l.order_name))
        .filter((v): v is string => Boolean(v)),
    ),
  ];

  const [guideLinks, candidates] = await Promise.all([
    fetchGuideLinks(admin, storeIds, guides),
    fetchOrderCandidates(admin, storeIds, names),
  ]);

  const rows = params.lines.map((l) => {
    const guideKey = l.guide_code?.trim().toLowerCase() ?? null;
    const byGuide = guideKey ? guideLinks.get(guideKey) : undefined;
    let orderId: string | null = byGuide?.orderId ?? null;

    if (!orderId) {
      const name = normalizeOrderName(l.order_name);
      if (name) {
        // `order_name_confirmed: true`: el nº salió de una columna de pedido o de
        // la transcripción de la hoja, no de adivinar dentro de un texto libre.
        // El emparejador sigue mandando a revisión lo ambiguo.
        const match = matchShipment(
          { order_name: name, order_name_confirmed: true, customer_phone: null },
          candidates,
        );
        if (match.matched) orderId = match.order_id;
      }
    }

    if (orderId) result.linked++;
    else result.review++;

    return {
      settlement_id: settlementId,
      order_id: orderId,
      guide_code: l.guide_code?.trim() || null,
      order_name: normalizeOrderName(l.order_name),
      declared_status: l.declared_status,
      declared_amount: l.declared_amount,
      match_status: orderId ? "ok" : "review",
      raw: l.raw,
    };
  });

  for (const batch of chunk(rows, 200)) {
    const { error } = await admin.from("rider_settlement_lines").insert(batch);
    if (error) {
      result.errors.push(error.message);
      continue;
    }
    result.inserted += batch.length;
  }

  return result;
}

/**
 * Corrige a mano el vínculo de una línea. Es la salida de la cola de revisión:
 * `orderId` la vincula, `null` la marca como "no corresponde a ningún pedido".
 * Ninguna de las dos toca el Master — solo dice a qué pedido pertenece la plata.
 */
export async function relinkSettlementLine(
  admin: SupabaseClient,
  lineId: string,
  orderId: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await admin
    .from("rider_settlement_lines")
    .update({
      order_id: orderId,
      match_status: orderId ? "ok" : "sin_pedido",
      updated_at: new Date().toISOString(),
    })
    .eq("id", lineId);
  return error ? { ok: false, error: error.message } : { ok: true };
}
