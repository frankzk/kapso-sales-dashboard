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
//   3. EL NOMBRE DEL CLIENTE, desempatado por distrito y acotado a los días
//      alrededor de la liquidación. Es el único identificador que trae una hoja
//      como la de Axel Courier, y por eso existe — pero un nombre NO es un
//      identificador: solo vincula cuando queda UN candidato.
//   4. NADA. La línea queda en `match_status = 'review'` y la resuelve una
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
  /** Courier que emite la hoja (axel…). Nulo = motorizado propio. */
  courier?: string | null;
  /** Comisión de POS declarada aparte de las entregas. */
  posFee?: number;
  /** Cobros que entraron directo a la empresa (POS, Yape, transferencia). */
  directCollected?: number;
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

/** Comparación de nombres tolerante: los couriers escriben "Edgard William",
 *  "EDGARD WILLIAM" y "Edgard  William" para la misma persona. */
function nameKey(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Candidato para emparejar por nombre y distrito, del Master. */
interface NameCandidate {
  order_id: string;
  store_id: string;
  store_name?: string | null;
  order_name?: string | null;
  customer_name: string | null;
  district: string | null;
  order_total?: number | null;
  general_status?: string | null;
}

/**
 * Pedidos del día para emparejar por NOMBRE cuando la hoja no trae guía ni nº de
 * pedido (el caso de Axel). Se acota al día de la liquidación con un margen de
 * un día a cada lado: un pedido creado anoche se entrega hoy, y uno de hoy puede
 * liquidarse mañana. Sin acotar, dos clientes homónimos de meses distintos
 * competirían por la misma fila.
 */
async function fetchNameCandidates(
  admin: SupabaseClient,
  storeIds: string[],
  day: string,
): Promise<NameCandidate[]> {
  if (!storeIds.length) return [];
  const from = new Date(`${day}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 3);
  const to = new Date(`${day}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 2);
  const [{ data }, { data: storeRows }] = await Promise.all([
    admin
      .from("order_master")
      .select("order_id,order_name,store_id,customer_name,district,order_total,general_status")
      .in("store_id", storeIds)
      .gte("order_created_at", from.toISOString())
      .lt("order_created_at", to.toISOString())
      .limit(5000),
    admin.from("stores").select("id,name").in("id", storeIds),
  ]);
  const storeNames = new Map(
    ((storeRows ?? []) as { id: string; name: string | null }[]).map((s) => [s.id, s.name]),
  );
  return ((data ?? []) as unknown as NameCandidate[]).map((candidate) => ({
    ...candidate,
    store_name: storeNames.get(candidate.store_id) ?? null,
  }));
}

/**
 * Empareja por nombre del cliente, desempatando por distrito.
 *
 * Un nombre NO es un identificador, así que esto es deliberadamente estricto:
 * solo vincula cuando queda UN candidato. Dos pedidos del mismo cliente el mismo
 * día, o dos homónimos en distritos que la hoja escribe distinto, van a revisión
 * — que es exactamente donde tienen que ir.
 */
export function matchByName(
  line: {
    customer_name?: string | null;
    district?: string | null;
    store_hint?: string | null;
  },
  candidates: readonly NameCandidate[],
): string | null {
  const want = nameKey(line.customer_name);
  if (!want || want.length < 4) return null;

  const storeHint = nameKey(line.store_hint);
  const scoped = storeHint
    ? candidates.filter((c) => {
        const store = nameKey(c.store_name);
        return (
          store === storeHint ||
          store.startsWith(storeHint) ||
          (store.length > 0 && storeHint.startsWith(store))
        );
      })
    : candidates;

  let byName = scoped.filter((c) => nameKey(c.customer_name) === want);
  // Los couriers truncan el nombre a lo que cabe en la celda ("Ana María Cárd").
  // Si nadie coincide exacto, se acepta que el nombre de la hoja sea prefijo del
  // del pedido, siempre que siga siendo único.
  if (!byName.length) {
    byName = scoped.filter((c) => nameKey(c.customer_name).startsWith(want));
  }
  if (byName.length === 1) return byName[0]!.order_id;
  if (byName.length > 1 && line.district) {
    const wantDistrict = nameKey(line.district);
    const byDistrict = byName.filter((c) => nameKey(c.district) === wantDistrict);
    if (byDistrict.length === 1) return byDistrict[0]!.order_id;
  }
  return null;
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
      courier: params.courier ?? null,
      pos_fee: params.posFee ?? 0,
      direct_collected: params.directCollected ?? 0,
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

  // Los candidatos por nombre solo se traen si hacen falta: una hoja con guías
  // no debe pagar una consulta de todos los pedidos del día.
  const needsNameMatch = params.lines.some(
    (l) => !l.guide_code && !l.order_name && Boolean(l.customer_name),
  );
  const [guideLinks, candidates, nameCandidates] = await Promise.all([
    fetchGuideLinks(admin, storeIds, guides),
    fetchOrderCandidates(admin, storeIds, names),
    needsNameMatch
      ? fetchNameCandidates(admin, storeIds, params.settlementDate)
      : Promise.resolve([] as NameCandidate[]),
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

    // Último recurso, para hojas como la de Axel que no traen ningún
    // identificador: nombre del cliente desempatado por distrito. Solo vincula
    // cuando queda un único candidato; lo demás va a revisión.
    if (!orderId && nameCandidates.length) {
      orderId = matchByName(l, nameCandidates);
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
      declared_fee: l.declared_fee,
      customer_name: l.customer_name,
      district: l.district,
      store_hint: l.store_hint ?? l.raw.cliente ?? null,
      payment_method: l.payment_method ?? null,
      match_status: orderId ? "ok" : "review",
      raw: {
        ...l.raw,
        store_hint: l.store_hint ?? l.raw.cliente ?? "",
        payment_method: l.payment_method ?? "",
      },
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
