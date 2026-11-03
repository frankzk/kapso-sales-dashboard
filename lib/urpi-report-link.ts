import type { SupabaseClient } from "@supabase/supabase-js";
import { urpiPhone, type UrpiReportRow } from "./urpi-report";
import type { UrpiProgrammingData } from "./urpi-programming";

/** El reporte de Urpi no trae código de pedido (decisión del owner, 05-10-2026,
 * MOM §30.11): una cadena de intentos se vincula por TELÉFONO a un único pedido
 * de la organización creado en los 45 días previos al envío. Con varios
 * candidatos queda a revisión; nunca se elige uno por cercanía ni por nombre. */
export const URPI_LINK_WINDOW_DAYS = 45;

export type UrpiLinkStatus = "vinculado" | "varios" | "sin_pedido" | "sin_telefono";
export type UrpiLinkMethod = "telefono" | "cadena" | "manual" | "programacion";

export interface UrpiLink {
  orderId: string | null;
  storeId: string | null;
  linkStatus: UrpiLinkStatus;
  linkMethod: UrpiLinkMethod | null;
  candidates: string[];
}

export interface UrpiCandidateOrder {
  orderId: string;
  storeId: string;
  phone: string;
  createdAt: string;
}

const norm = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const MAX_CANDIDATES = 10;

/** «KENKU» → la tienda cuyo nombre lo contiene; ambiguo o sin match → null. */
export function urpiStoreFromHint(hint: string | null, stores: readonly { id: string; name: string }[]): string | null {
  const key = hint ? norm(hint) : "";
  if (!key) return null;
  const found = stores.filter((store) => norm(store.name).includes(key) || key.includes(norm(store.name)));
  return found.length === 1 ? found[0]!.id : null;
}

/** Ventana del vínculo en hora de Lima: desde 45 días antes del envío hasta el
 * final del día del envío. Sin fecha, cualquier pedido del teléfono cuenta. */
function inWindow(createdAt: string, reportDate: string | null): boolean {
  if (!reportDate) return true;
  const end = Date.parse(`${reportDate}T05:00:00Z`) + 86400000;
  const start = end - (URPI_LINK_WINDOW_DAYS + 1) * 86400000;
  const at = Date.parse(createdAt);
  return at >= start && at < end;
}

/** Lo programado a Urpi por día y teléfono: `AAAA-MM-DD|9XXXXXXXX` → pedidos
 *  de la programación enviada, vinculados por código exacto (MOM §30.10). */
export type UrpiProgrammedIndex = ReadonlyMap<string, readonly { orderId: string; storeId: string }[]>;

export const urpiProgrammedKey = (date: string, phone: string) => `${date}|${phone}`;

/** El índice a partir de las programaciones guardadas de cada tienda. PURA. */
export function buildUrpiProgrammedIndex(books: readonly { storeId: string; payload: Pick<UrpiProgrammingData, "rows"> }[]): Map<string, { orderId: string; storeId: string }[]> {
  const index = new Map<string, { orderId: string; storeId: string }[]>();
  for (const book of books) {
    for (const row of book.payload.rows ?? []) {
      const phone = urpiPhone(row.phone);
      if (!row.orderId || !phone || !row.date) continue;
      const key = urpiProgrammedKey(row.date, phone);
      const list = index.get(key) ?? [];
      if (!list.some((item) => item.orderId === row.orderId)) list.push({ orderId: row.orderId, storeId: book.storeId });
      index.set(key, list);
    }
  }
  return index;
}

/**
 * Vínculo de cada fila. Una fila con «Row number relacionado» sigue a su
 * cadena: es el mismo envío reintentado. La cabeza de la cadena se busca por
 * teléfono; un vínculo manual (guardado en `existing`) manda sobre todo.
 *
 * LA PROGRAMACIÓN (03-11-2026). Cuando el teléfono no basta —varios pedidos en
 * la ventana, o ninguno—, decide la programación enviada a Urpi: si ese día ese
 * teléfono se programó con UN solo pedido, es ese, porque la programación lo
 * nombra por código. Solo desempata o completa: un vínculo por teléfono único
 * no se cambia, y dos pedidos programados el mismo día con el mismo teléfono
 * siguen por vincular.
 */
export function resolveUrpiLinks(
  rows: readonly UrpiReportRow[],
  orders: readonly UrpiCandidateOrder[],
  existing: ReadonlyMap<number, UrpiLink>,
  stores: readonly { id: string; name: string }[],
  programmed: UrpiProgrammedIndex = new Map(),
): Map<number, UrpiLink> {
  const byRow = new Map(rows.map((row) => [row.urpiRow, row]));
  const byPhone = new Map<string, UrpiCandidateOrder[]>();
  for (const order of orders) byPhone.set(order.phone, [...(byPhone.get(order.phone) ?? []), order]);
  const out = new Map<number, UrpiLink>();
  const resolving = new Set<number>();

  const head = (row: UrpiReportRow): UrpiLink => {
    if (!row.phone) return { orderId: null, storeId: null, linkStatus: "sin_telefono", linkMethod: null, candidates: [] };
    let found = (byPhone.get(row.phone) ?? []).filter((order) => inWindow(order.createdAt, row.reportDate));
    const hinted = urpiStoreFromHint(row.storeHint, stores);
    if (hinted && found.some((order) => order.storeId === hinted)) found = found.filter((order) => order.storeId === hinted);
    const ids = [...new Set(found.map((order) => order.orderId))];
    if (ids.length === 1) return { orderId: ids[0]!, storeId: found[0]!.storeId, linkStatus: "vinculado", linkMethod: "telefono", candidates: [] };
    const sent = row.reportDate ? programmed.get(urpiProgrammedKey(row.reportDate, row.phone)) ?? [] : [];
    if (sent.length === 1) return { orderId: sent[0]!.orderId, storeId: sent[0]!.storeId, linkStatus: "vinculado", linkMethod: "programacion", candidates: [] };
    if (ids.length > 1) return { orderId: null, storeId: null, linkStatus: "varios", linkMethod: "telefono", candidates: ids.slice(0, MAX_CANDIDATES) };
    return { orderId: null, storeId: null, linkStatus: "sin_pedido", linkMethod: null, candidates: [] };
  };

  const resolve = (urpiRow: number): UrpiLink | null => {
    const known = existing.get(urpiRow);
    if (known?.linkMethod === "manual") return known;
    const cached = out.get(urpiRow);
    if (cached) return cached;
    const row = byRow.get(urpiRow);
    if (!row) return known ?? null;
    if (resolving.has(urpiRow)) return head(row); // cadena circular: se trata como cabeza
    resolving.add(urpiRow);
    const parent = row.previousRow !== null && row.previousRow !== urpiRow ? resolve(row.previousRow) : null;
    const link: UrpiLink = parent ? { ...parent, linkMethod: parent.linkStatus === "sin_telefono" || parent.linkStatus === "sin_pedido" ? null : "cadena" } : head(row);
    resolving.delete(urpiRow);
    out.set(urpiRow, link);
    return link;
  };

  for (const row of rows) resolve(row.urpiRow);
  return new Map(rows.map((row) => [row.urpiRow, out.get(row.urpiRow) ?? existing.get(row.urpiRow)!]));
}

/**
 * Las programaciones vigentes de esas tiendas en esos meses (AAAA-MM), como
 * índice por día y teléfono. Es una ayuda para vincular: si no se puede leer,
 * el reporte se vincula solo por teléfono, como antes.
 */
export async function loadUrpiProgrammedIndex(admin: SupabaseClient, storeIds: readonly string[], months: readonly string[]): Promise<Map<string, { orderId: string; storeId: string }[]>> {
  if (!storeIds.length || !months.length) return new Map();
  const { data: sources, error } = await admin.from("urpi_programming_sources").select("store_id,current_snapshot_id")
    .in("store_id", [...storeIds]).in("month", [...new Set(months)]).not("current_snapshot_id", "is", null);
  if (error || !sources?.length) return new Map();
  const storeOf = new Map((sources as { store_id: string; current_snapshot_id: string }[]).map((source) => [source.current_snapshot_id, source.store_id]));
  const { data: snapshots, error: snapshotError } = await admin.from("urpi_programming_snapshots").select("id,payload").in("id", [...storeOf.keys()]);
  if (snapshotError) return new Map();
  return buildUrpiProgrammedIndex(((snapshots ?? []) as { id: string; payload: UrpiProgrammingData }[])
    .map((snapshot) => ({ storeId: storeOf.get(snapshot.id)!, payload: snapshot.payload })));
}

/** Pedidos de las tiendas con esos teléfonos. `order_master` guarda «51» + 9. */
export async function loadUrpiCandidateOrders(admin: SupabaseClient, storeIds: readonly string[], phones: readonly string[]): Promise<UrpiCandidateOrder[]> {
  const unique = [...new Set(phones)];
  const out: UrpiCandidateOrder[] = [];
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100).map((phone) => `51${phone}`);
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from("order_master").select("order_id,store_id,customer_phone,order_created_at")
        .in("store_id", [...storeIds]).in("customer_phone", batch).order("order_id").range(from, from + 999);
      if (error) throw new Error("No se pudieron buscar los pedidos por teléfono. No se guardó el reporte.");
      for (const row of (data ?? []) as { order_id: string; store_id: string; customer_phone: string; order_created_at: string | null }[]) {
        if (row.order_created_at) out.push({ orderId: row.order_id, storeId: row.store_id, phone: row.customer_phone.slice(2), createdAt: row.order_created_at });
      }
      if ((data ?? []).length < 1000) break;
    }
  }
  return out;
}
