// Un reporte de movimientos de Yape llegado por correo (MOM §16.2): guardarlo,
// cruzarlo con «Validar pagos» y validar lo que coincide sin margen de duda.
// Lo llama el webhook que alimenta Make (/api/webhooks/yape-movements).
//
// El orden importa:
//   1. guardar los movimientos (son hechos, y quedan aunque lo demás falle);
//   2. ponerle hora a los cobros de courier que entraron sin ella;
//   3. cruzar (lib/yape-statement/match.ts, puro y probado);
//   4. validar cada coincidencia por el MISMO camino que una persona
//      (lib/payment-validation.ts), con `actor` nulo y fuente `estado_yape`, y
//      como ella, soltar la clave de recojo si ese pago completa un pedido de
//      agencia (lib/pickup-key-delivery.ts).
//
// SERVER-ONLY: escribe con la clave de servicio.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCollectionAccounts } from "@/lib/collection-accounts";
import { applyPaymentValidation } from "@/lib/payment-validation";
import { deliverPickupKey } from "@/lib/pickup-key-delivery";
import { backfillCourierPaidAt, type CourierTimeBackfillReport } from "@/lib/tanders/collection-time-backfill";
import {
  matchStatement,
  statementAccountKey,
  type MatchableMovement,
  type SkipReason,
  type StatementPayment,
} from "@/lib/yape-statement/match";
import { parseYapeStatement, type StatementMovement } from "@/lib/yape-statement/parse";
import { yapeRecipientReadingFromVision } from "@/lib/yape-recipient";

export const STATEMENT_SOURCE = "estado_yape";

export interface StatementRunInput {
  messageId: string;
  fileName: string;
  receivedAt: string | null;
  subject: string | null;
  bytes: Buffer;
  /** Simulacro: calcula todo y no escribe nada. */
  dryRun: boolean;
  /** Tope de tiempo para releer constancias y validar. */
  budgetMs: number;
}

export interface StatementValidation {
  pedido: string | null;
  tipo: string;
  monto: number;
  movimiento: string;
  hora: string;
  regla: string;
  /** Pedido de agencia: si su clave de recojo salió al validar, o por qué no. */
  clave?: string;
}

export interface StatementRunResult {
  outcome: "procesado" | "simulacro" | "sin_movimientos" | "sin_tienda";
  importId: string | null;
  periodo: { desde: string | null; hasta: string | null };
  movimientos: number;
  nuevos: number;
  ilegibles: number;
  horasCourier: CourierTimeBackfillReport | null;
  validados: StatementValidation[];
  omitidos: Partial<Record<SkipReason | "receptor_no_cuadra" | "cambio_de_estado" | "error" | "sin_tiempo", number>>;
  errores: string[];
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

function limaClock(iso: string): string {
  return new Date(Date.parse(iso) - 5 * HOUR).toISOString().slice(0, 19).replace("T", " ");
}

/** De dónde salió la lectura guardada con el comprobante, si consta. */
function visionSourceOf(vision: unknown): string | null {
  const root = vision && typeof vision === "object" ? (vision as Record<string, unknown>) : {};
  return typeof root.source === "string" ? root.source : null;
}

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Todas las filas de una consulta, de mil en mil (el tope de PostgREST). */
async function selectAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

/** Las tiendas que cobran en la cuenta del reporte: la tiene entre sus cuentas de cobro. */
async function storesForDestination(admin: SupabaseClient, destination: string): Promise<string[]> {
  const { data } = await admin
    .from("store_collection_accounts")
    .select("store_id,label,aliases")
    .eq("active", true);
  const want = statementAccountKey(destination);
  return [
    ...new Set(
      ((data ?? []) as { store_id: string; label: string; aliases: string[] | null }[])
        .filter((a) => [a.label, ...(a.aliases ?? [])].some((n) => statementAccountKey(n) === want))
        .map((a) => a.store_id),
    ),
  ];
}

interface PaymentRow {
  id: string;
  order_id: string;
  store_id: string;
  kind: string;
  amount: number | string | null;
  paid_at: string | null;
  registered_at: string;
  validation_status: string;
  operation_number: string | null;
  operation_completed_by: string | null;
  payer_name: string | null;
  vision: unknown;
}

const PAYMENT_COLS =
  "id,order_id,store_id,kind,amount,paid_at,registered_at,validation_status," +
  "operation_number,operation_completed_by,payer_name,vision";

function toStatementPayment(row: PaymentRow, order: { name: string | null; customer: string | null } | undefined): StatementPayment {
  const vision = row.vision && typeof row.vision === "object" ? (row.vision as Record<string, unknown>) : {};
  const extracted =
    vision.extracted && typeof vision.extracted === "object" ? (vision.extracted as Record<string, unknown>) : {};
  return {
    id: row.id,
    orderName: order?.name ?? null,
    kind: row.kind,
    amount: row.amount == null ? null : Number(row.amount),
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    registeredAt: new Date(row.registered_at).toISOString(),
    status: row.validation_status,
    operationNumber: row.operation_number,
    operationTypedBy: row.operation_completed_by,
    customerName: order?.customer ?? null,
    payerName: row.payer_name ?? (typeof extracted.payer_name === "string" ? extracted.payer_name : null),
    courierMethod: typeof vision.method === "string" ? vision.method : null,
    courierToYape: typeof vision.to_yape === "boolean" ? vision.to_yape : null,
  };
}

const KIND_LABEL: Record<string, string> = {
  adelanto: "Adelanto",
  diferencia: "Diferencia",
  total: "Pago total",
  cobro_courier: "Cobro del courier",
};

export async function ingestYapeStatement(
  admin: SupabaseClient,
  input: StatementRunInput,
): Promise<StatementRunResult> {
  const started = Date.now();
  const deadline = started + input.budgetMs;
  const parsed = await parseYapeStatement(input.bytes);
  const ingresos = parsed.movements.filter((m) => m.kind === "ingreso");
  const result: StatementRunResult = {
    outcome: input.dryRun ? "simulacro" : "procesado",
    importId: null,
    periodo: { desde: parsed.from, hasta: parsed.to },
    movimientos: parsed.movements.length,
    nuevos: 0,
    ilegibles: parsed.unreadable,
    horasCourier: null,
    validados: [],
    omitidos: {},
    errores: [],
  };
  const omit = (reason: keyof StatementRunResult["omitidos"]) => {
    result.omitidos[reason] = (result.omitidos[reason] ?? 0) + 1;
  };

  // La cuenta del reporte: el destino de sus ingresos.
  const counts = new Map<string, number>();
  for (const m of ingresos) counts.set(m.destination, (counts.get(m.destination) ?? 0) + 1);
  const destination = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const logImport = async (extra: Record<string, unknown>) => {
    if (input.dryRun) return null;
    const { data } = await admin
      .from("yape_statement_imports")
      .insert({
        message_id: input.messageId,
        file_name: input.fileName,
        received_at: input.receivedAt,
        subject: input.subject,
        destination,
        period_from: parsed.from,
        period_to: parsed.to,
        movements: parsed.movements.length,
        unreadable: parsed.unreadable,
        ...extra,
      })
      .select("id")
      .single();
    return (data as { id: string } | null)?.id ?? null;
  };

  if (!ingresos.length || !destination || !parsed.from || !parsed.to) {
    result.outcome = "sin_movimientos";
    result.importId = await logImport({ error: "el reporte no trae ingresos legibles", finished_at: new Date().toISOString() });
    return result;
  }
  const storeIds = await storesForDestination(admin, destination);
  if (!storeIds.length) {
    result.outcome = "sin_tienda";
    result.importId = await logImport({
      error: `ninguna tienda tiene «${destination}» entre sus cuentas de cobro`,
      finished_at: new Date().toISOString(),
    });
    return result;
  }
  result.importId = await logImport({});

  // 1. Los movimientos, una sola vez aunque lleguen en varios reportes.
  if (!input.dryRun) {
    const known = new Set<string>();
    for (const part of chunks(parsed.movements.map((m) => m.key), 300)) {
      const { data } = await admin.from("yape_statement_movements").select("movement_key").in("movement_key", part);
      for (const r of (data ?? []) as { movement_key: string }[]) known.add(r.movement_key);
    }
    const fresh = parsed.movements.filter((m) => !known.has(m.key));
    for (const part of chunks(fresh, 500)) {
      const { error } = await admin.from("yape_statement_movements").upsert(
        part.map((m: StatementMovement) => ({
          movement_key: m.key,
          kind: m.kind,
          origin: m.origin,
          destination: m.destination,
          channel: m.channel,
          payer_name: m.payerName,
          amount: m.amount,
          occurred_at: m.occurredAt,
          extra: m.extra,
          first_import_id: result.importId,
        })),
        { onConflict: "movement_key", ignoreDuplicates: true },
      );
      if (error) result.errores.push(`movimientos: ${error.message}`);
    }
    result.nuevos = fresh.length;

    // 2. Hora para los cobros de courier que entraron sin ella. Antes del 04-10
    //    el lector de Tanders no la leía; sin hora no hay cruce al minuto.
    result.horasCourier = await backfillCourierPaidAt(admin, {
      budgetMs: Math.max(0, Math.min(90_000, deadline - Date.now() - 60_000)),
    });
  }

  // 3. El cruce. Una constancia con la hora leída 12 h antes (el «p. m.»
  //    perdido) guarda una hora hasta 12 h anterior al movimiento.
  const lo = new Date(Date.parse(parsed.from) - 12 * HOUR - 5 * MINUTE).toISOString();
  const hi = new Date(Date.parse(parsed.to) + 5 * MINUTE).toISOString();
  const amounts = [...new Set(ingresos.map((m) => m.amount))];
  const pendingRows = await selectAll<PaymentRow>((from, to) =>
    admin
      .from("order_payments")
      .select(PAYMENT_COLS)
      .in("store_id", storeIds)
      .eq("validation_status", "pendiente_revision")
      .gte("paid_at", lo)
      .lte("paid_at", hi)
      .order("id")
      .range(from, to),
  );
  const liveRows = await selectAll<PaymentRow>((from, to) =>
    admin
      .from("order_payments")
      .select(PAYMENT_COLS)
      .in("store_id", storeIds)
      .neq("validation_status", "rechazado")
      .in("amount", amounts)
      .gte("paid_at", lo)
      .lte("paid_at", hi)
      .order("id")
      .range(from, to),
  );
  const orderIds = [...new Set([...pendingRows, ...liveRows].map((r) => r.order_id))];
  const orders = new Map<string, { name: string | null; customer: string | null }>();
  for (const part of chunks(orderIds, 200)) {
    const { data } = await admin
      .from("order_master")
      .select("order_id,order_name,customer_name")
      .in("order_id", part);
    for (const o of (data ?? []) as { order_id: string; order_name: string | null; customer_name: string | null }[]) {
      orders.set(o.order_id, { name: o.order_name, customer: o.customer_name });
    }
  }
  const pending = pendingRows.map((r) => toStatementPayment(r, orders.get(r.order_id)));
  const pendingIds = new Set(pending.map((p) => p.id));
  const live = [
    ...pending,
    ...liveRows.filter((r) => !pendingIds.has(r.id)).map((r) => toStatementPayment(r, orders.get(r.order_id))),
  ];

  const linkedMovements = new Set<string>();
  const linkedPayments = new Set<string>();
  for (const part of chunks(ingresos.map((m) => m.key), 300)) {
    const { data } = await admin.from("yape_statement_matches").select("movement_key,payment_id").in("movement_key", part);
    for (const r of (data ?? []) as { movement_key: string; payment_id: string }[]) {
      linkedMovements.add(r.movement_key);
      linkedPayments.add(r.payment_id);
    }
  }
  for (const part of chunks([...pendingIds], 300)) {
    const { data } = await admin.from("yape_statement_matches").select("movement_key,payment_id").in("payment_id", part);
    for (const r of (data ?? []) as { movement_key: string; payment_id: string }[]) {
      linkedMovements.add(r.movement_key);
      linkedPayments.add(r.payment_id);
    }
  }

  const movements: MatchableMovement[] = ingresos;
  const { matches, skipped } = matchStatement(movements, pending, live, {
    movementKeys: linkedMovements,
    paymentIds: linkedPayments,
  });
  for (const s of skipped) omit(s.reason);

  // 4. Validar. Por el mismo camino que una persona, firmado por el reporte.
  const byKey = new Map(ingresos.map((m) => [m.key, m]));
  const rowById = new Map(pendingRows.map((r) => [r.id, r]));
  const payById = new Map(pending.map((p) => [p.id, p]));
  const accounts = await loadCollectionAccounts(admin, storeIds);

  for (const match of matches) {
    const row = rowById.get(match.paymentId)!;
    const pay = payById.get(match.paymentId)!;
    const m = byKey.get(match.movementKey)!;
    const summary: StatementValidation = {
      pedido: pay.orderName,
      tipo: row.kind,
      monto: m.amount,
      movimiento: m.origin,
      hora: limaClock(m.occurredAt),
      regla: match.rule,
    };
    // La regla de la cuenta receptora sigue valiendo: si la lectura dice que
    // el dinero fue a otra cuenta, eso lo levanta un administrador por escrito,
    // nunca el cruce.
    const recipient = yapeRecipientReadingFromVision(row.vision, accounts.get(row.store_id) ?? [], pay.customerName);
    if (recipient.status === "mismatch") {
      omit("receptor_no_cuadra");
      continue;
    }
    if (input.dryRun) {
      result.validados.push(summary);
      continue;
    }
    if (Date.now() > deadline) {
      omit("sin_tiempo");
      continue;
    }
    const { error: linkErr } = await admin.from("yape_statement_matches").insert({
      movement_key: m.key,
      payment_id: row.id,
      order_id: row.order_id,
      store_id: row.store_id,
      import_id: result.importId,
      rule: match.rule,
      delta_seconds: match.deltaSeconds,
      validated: false,
    });
    if (linkErr) {
      // El único: otro proceso concilió antes este movimiento o este pago.
      omit("ya_conciliado");
      continue;
    }
    const applied = await applyPaymentValidation(admin, {
      payment: row,
      who: { storeId: row.store_id, actor: null, source: STATEMENT_SOURCE },
      note:
        `${KIND_LABEL[row.kind] ?? row.kind} validado por el estado de cuenta de Yape: ` +
        `${m.origin} · S/ ${m.amount.toFixed(2)} · ${limaClock(m.occurredAt)}.`,
      payload: {
        movimiento: {
          origen: m.origin,
          canal: m.channel,
          monto: m.amount,
          hora: m.occurredAt,
          llave: m.key,
        },
        regla: match.rule,
        delta_segundos: match.deltaSeconds,
        reporte: result.importId,
      },
      liquidationNote:
        "Cobro del courier conciliado con el estado de cuenta de Yape: el dinero de este pedido entró a la cuenta.",
      onlyIfStatus: "pendiente_revision",
    });
    if (!applied.ok) {
      // No llegó a validarse: el movimiento vuelve a quedar libre.
      await admin.from("yape_statement_matches").delete().eq("payment_id", row.id).eq("validated", false);
      if (applied.stale) omit("cambio_de_estado");
      else {
        omit("error");
        result.errores.push(`${pay.orderName ?? row.id}: ${applied.error}`);
      }
      continue;
    }
    await admin.from("yape_statement_matches").update({ validated: true }).eq("payment_id", row.id);
    // LA CLAVE, COMO CUANDO VALIDA UNA PERSONA (10-10-2026). Validar el pago que
    // completa un pedido de agencia es lo que suelta su clave de recojo; antes
    // esto validaba y nadie se la mandaba (#KP139240). Las mismas rejas que el
    // botón (lib/pickup-key-delivery.ts): pago completo, ventana de 24 h e
    // interruptor de envío automático de la tienda. El comprobante que entró
    // por WhatsApp es su mensaje: la ventana cuenta desde ahí.
    if (Date.now() < deadline) {
      const envio = await deliverPickupKey(admin, {
        storeId: row.store_id,
        orderId: row.order_id,
        actor: null,
        trigger: "estado_yape",
        extraInboundAt: visionSourceOf(row.vision) === "wa_cobranza_shalom" ? row.registered_at : null,
      });
      if (!envio.noKey) summary.clave = envio.sent ? "enviada" : envio.note;
    }
    result.validados.push(summary);
  }

  if (result.importId) {
    await admin
      .from("yape_statement_imports")
      .update({
        new_movements: result.nuevos,
        validated: result.validados.length,
        report: {
          validados: result.validados,
          omitidos: result.omitidos,
          horas_courier: result.horasCourier,
          errores: result.errores,
        },
        error: result.errores.length ? result.errores.slice(0, 5).join(" · ") : null,
        finished_at: new Date().toISOString(),
      })
      .eq("id", result.importId);
  }
  return result;
}
