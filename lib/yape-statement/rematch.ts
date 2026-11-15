// El recruce con los movimientos de Yape YA GUARDADOS (MOM §16.2; owner,
// 13-11-2026: «si, prepáralo»).
//
// EL HUECO. El cruce corría solo al llegar un reporte, y solo con los
// comprobantes que ya estaban cargados en ese momento. Un comprobante que se
// carga DESPUÉS de que llegó el reporte de su hora no volvía a cruzarse: el
// dinero estaba en `yape_statement_movements` y el comprobante se quedaba en
// «Pendiente de revisión» esperando a una persona (#KP204474, adelanto de S/ 30
// del 08-11 a una cuenta que sí se cruza).
//
// LA REGLA. Cada media hora (`/api/cron/yape-rematch`), los comprobantes
// «Pendiente de revisión» de los últimos días se cruzan con los ingresos ya
// guardados, cuenta por cuenta, con la MISMA función que la importación
// (`crossAndValidate`): mismas rejas (monto, minuto, la clienta o el canal,
// inequívoco, nunca un movimiento posterior a la carga, cuenta receptora) y el
// mismo camino de validación, firmado por el estado de cuenta. Lo que ya
// concilió algo no se vuelve a usar (`yape_statement_matches`, único por
// movimiento y por comprobante). Sin nada que validar no deja rastro; si valida
// o falla, queda en el registro de «Validación de pagos» como «Recruce».
//
// SERVER-ONLY: escribe con la clave de servicio.

import type { SupabaseClient } from "@supabase/supabase-js";
import { crossAndValidate, storesForDestination, type CrossResult } from "@/lib/yape-statement/ingest";
import type { StatementMovement } from "@/lib/yape-statement/parse";

/** Cuántos días atrás se buscan comprobantes por validar. */
export const REMATCH_LOOKBACK_DAYS = 10;
/** El `message_id` del registro: no viene de ningún correo. */
export const REMATCH_MESSAGE_PREFIX = "recruce:";

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface RematchResult {
  pendientes: number;
  cuentas: number;
  movimientos: number;
  validados: CrossResult["validados"];
  omitidos: CrossResult["omitidos"];
  errores: string[];
  importIds: string[];
}

interface MovementRow {
  movement_key: string;
  kind: "ingreso" | "egreso";
  origin: string;
  destination: string;
  channel: string;
  payer_name: string;
  amount: number | string;
  occurred_at: string;
  extra: string | null;
}

async function readPages<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

/** Los ingresos guardados, como los entrega el lector del reporte. Pura. */
export function storedMovement(row: MovementRow): StatementMovement {
  return {
    key: row.movement_key,
    kind: row.kind,
    origin: row.origin,
    destination: row.destination,
    channel: row.channel,
    payerName: row.payer_name,
    amount: Number(row.amount),
    occurredAt: new Date(row.occurred_at).toISOString(),
    extra: row.extra,
  };
}

/** Los ingresos agrupados por la cuenta que los recibió, con su periodo. Pura. */
export function movementsByAccount(movements: readonly StatementMovement[]): Map<string, { ingresos: StatementMovement[]; from: string; to: string }> {
  const out = new Map<string, { ingresos: StatementMovement[]; from: string; to: string }>();
  for (const m of movements) {
    if (m.kind !== "ingreso") continue;
    const group = out.get(m.destination) ?? { ingresos: [], from: m.occurredAt, to: m.occurredAt };
    group.ingresos.push(m);
    if (m.occurredAt < group.from) group.from = m.occurredAt;
    if (m.occurredAt > group.to) group.to = m.occurredAt;
    out.set(m.destination, group);
  }
  return out;
}

export async function rematchStoredMovements(
  admin: SupabaseClient,
  opts: { now?: Date; lookbackDays?: number; budgetMs: number; dryRun?: boolean },
): Promise<RematchResult> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + opts.budgetMs;
  const since = new Date(now.getTime() - (opts.lookbackDays ?? REMATCH_LOOKBACK_DAYS) * DAY).toISOString();
  const result: RematchResult = { pendientes: 0, cuentas: 0, movimientos: 0, validados: [], omitidos: {}, errores: [], importIds: [] };

  // 1. Lo que espera a una persona: si no hay nada, no se lee nada más.
  const pending = await readPages<{ store_id: string; amount: number | string | null; paid_at: string | null }>((from, to) =>
    admin
      .from("order_payments")
      .select("store_id,amount,paid_at")
      .eq("validation_status", "pendiente_revision")
      .gte("paid_at", since)
      .order("id")
      .range(from, to),
  );
  result.pendientes = pending.length;
  const amounts = [...new Set(pending.map((p) => Number(p.amount)).filter((a) => Number.isFinite(a) && a > 0))];
  if (!amounts.length) return result;
  const earliest = pending.reduce((min, p) => (p.paid_at && p.paid_at < min ? p.paid_at : min), now.toISOString());

  // 2. Solo los ingresos guardados que podrían ser alguno: mismo monto, desde
  //    el comprobante más viejo (con la holgura del cruce) hasta ahora.
  const rows: MovementRow[] = [];
  for (let i = 0; i < amounts.length; i += 200) {
    rows.push(
      ...(await readPages<MovementRow>((from, to) =>
        admin
          .from("yape_statement_movements")
          .select("movement_key,kind,origin,destination,channel,payer_name,amount,occurred_at,extra")
          .eq("kind", "ingreso")
          .in("amount", amounts.slice(i, i + 200))
          .gte("occurred_at", new Date(Date.parse(earliest) - 5 * MINUTE).toISOString())
          .order("movement_key")
          .range(from, to),
      )),
    );
  }
  const pendingStores = new Set(pending.map((p) => p.store_id));

  // 3. Cuenta por cuenta, con la función de la importación.
  for (const [destination, group] of movementsByAccount(rows.map(storedMovement))) {
    if (Date.now() > deadline) {
      result.omitidos.sin_tiempo = (result.omitidos.sin_tiempo ?? 0) + 1;
      break;
    }
    const storeIds = await storesForDestination(admin, destination);
    if (!storeIds.some((id) => pendingStores.has(id))) continue;
    result.cuentas += 1;
    result.movimientos += group.ingresos.length;
    const cross: CrossResult = { validados: [], omitidos: {}, errores: [], importId: null };
    await crossAndValidate(admin, {
      storeIds,
      ingresos: group.ingresos,
      from: group.from,
      to: group.to,
      importId: null,
      dryRun: Boolean(opts.dryRun),
      deadline,
      result: cross,
    });
    result.validados.push(...cross.validados);
    for (const [k, v] of Object.entries(cross.omitidos)) {
      const key = k as keyof CrossResult["omitidos"];
      result.omitidos[key] = (result.omitidos[key] ?? 0) + (v ?? 0);
    }
    result.errores.push(...cross.errores);

    // 4. El rastro, solo si hubo algo que contar: el registro de «Validación
    //    de pagos» lo muestra como un reporte más, marcado «Recruce».
    if (!opts.dryRun && (cross.validados.length || cross.errores.length)) {
      const { data } = await admin
        .from("yape_statement_imports")
        .insert({
          message_id: `${REMATCH_MESSAGE_PREFIX}${now.toISOString()}`,
          file_name: "Recruce con los movimientos ya guardados",
          subject: "Recruce: comprobantes cargados después de su reporte",
          destination,
          period_from: group.from,
          period_to: group.to,
          movements: group.ingresos.length,
          validated: cross.validados.length,
          report: { validados: cross.validados, omitidos: cross.omitidos, errores: cross.errores },
          error: cross.errores.length ? cross.errores.slice(0, 5).join(" · ") : null,
          finished_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      const id = (data as { id: string } | null)?.id;
      if (id) result.importIds.push(id);
    }
  }
  return result;
}
