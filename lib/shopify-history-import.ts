// Historial de Shopify por API (MOM §37.5): pedir el archivo a Shopify y leerlo
// por tandas. Solo servidor (service role). Escribe SOLO en las tablas del
// historial (`shopify_history_*`): nunca en `orders` ni en el Master.
//
// El ciclo de una traída (`shopify_history_imports`):
//   preparando  Shopify arma el archivo (la bulk operation corre allá).
//   importando  Kapta lo lee desde `bytes_done`, ~100 s por tanda, y guarda
//               cada 500 pedidos o clientes con la misma clave que el CSV.
//   listo       se leyó hasta el final.
//   error       Shopify falló o el archivo venció; se vuelve a traer.
// Quien avanza una tanda la reserva (`lease_until`): dos pestañas no leen el
// mismo pedazo a la vez. Si la pestaña se cierra, la traída sigue donde quedó.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getStoreCreds } from "@/lib/ingest";
import { shopifyGraphQL } from "@/lib/shopify";
import {
  bulkOutcome,
  bulkQueryFor,
  groupBulkOrders,
  isTopLevel,
  mapBulkCustomer,
  mergeLineItems,
  splitJsonl,
  type BulkKind,
  type JsonlLine,
} from "@/lib/shopify-history-bulk";
import type { HistoryCustomer, HistoryLineItem, HistoryOrder } from "@/lib/shopify-history";

export interface HistoryImportRow {
  id: string;
  store_id: string;
  kind: BulkKind;
  bulk_operation_id: string | null;
  status: "preparando" | "importando" | "listo" | "error";
  url: string | null;
  file_size: number | null;
  object_count: number | null;
  bytes_done: number;
  records: number;
  first_at: string | null;
  last_at: string | null;
  error: string | null;
  lease_until: string | null;
  created_at: string;
  finished_at: string | null;
}

export const IMPORT_COLUMNS =
  "id,store_id,kind,bulk_operation_id,status,url,file_size,object_count,bytes_done,records,first_at,last_at,error,lease_until,created_at,finished_at";

/** Cuánto lee una tanda antes de devolver el control (la página da 300 s). */
export const IMPORT_BUDGET_MS = 100_000;
/** Cuánto dura la reserva de una tanda. */
export const IMPORT_LEASE_MS = 280_000;
/** Pedidos o clientes por escritura. */
export const IMPORT_WRITE_BATCH = 500;

export type RowWriter = {
  orders: (rows: HistoryOrder[], importId: string) => Promise<number>;
  customers: (rows: HistoryCustomer[], importId: string) => Promise<number>;
  /** Suma productos a pedidos ya guardados (por id de pedido de Shopify). */
  orphans: (orphans: Map<string, HistoryLineItem[]>) => Promise<void>;
};

async function creds(storeId: string) {
  const c = await getStoreCreds(storeId);
  if (!c?.shopify_domain || !c.shopify_token) throw new Error("La tienda no tiene conexión con Shopify en Kapta.");
  return { domain: c.shopify_domain, token: c.shopify_token };
}

/** Empieza una traída, o devuelve la que ya está en curso para esa tienda y tipo. */
export async function startHistoryImport(
  admin: SupabaseClient,
  storeId: string,
  kind: BulkKind,
  userId: string,
): Promise<HistoryImportRow> {
  const active = await admin
    .from("shopify_history_imports")
    .select(IMPORT_COLUMNS)
    .eq("store_id", storeId)
    .eq("kind", kind)
    .in("status", ["preparando", "importando"])
    .maybeSingle();
  if (active.data) return active.data as HistoryImportRow;

  const shop = await creds(storeId);
  const data = await shopifyGraphQL<{
    bulkOperationRunQuery: { bulkOperation: { id: string; status: string } | null; userErrors: { message: string }[] };
  }>({
    ...shop,
    query: `mutation run($q: String!) {
      bulkOperationRunQuery(query: $q) { bulkOperation { id status } userErrors { field message } }
    }`,
    variables: { q: bulkQueryFor(kind) },
  });
  const run = data.bulkOperationRunQuery;
  if (!run.bulkOperation) {
    const why = run.userErrors.map((e) => e.message).join("; ") || "sin respuesta";
    throw new Error(`Shopify no aceptó la traída: ${why}`);
  }
  const { data: row, error } = await admin
    .from("shopify_history_imports")
    .insert({ store_id: storeId, kind, bulk_operation_id: run.bulkOperation.id, status: "preparando", started_by: userId })
    .select(IMPORT_COLUMNS)
    .single();
  if (error || !row) throw new Error(`No se pudo registrar la traída: ${error?.message ?? "sin respuesta"}`);
  return row as HistoryImportRow;
}

/** Revisa en Shopify cómo va el archivo; si está listo, pasa a importar. */
async function checkPreparing(admin: SupabaseClient, row: HistoryImportRow): Promise<HistoryImportRow> {
  const shop = await creds(row.store_id);
  const data = await shopifyGraphQL<{
    node: { status: string; errorCode: string | null; objectCount: string | null; fileSize: string | null; url: string | null } | null;
  }>({
    ...shop,
    query: `query op($id: ID!) { node(id: $id) { ... on BulkOperation { status errorCode objectCount fileSize url } } }`,
    variables: { id: row.bulk_operation_id },
  });
  const op = data.node;
  const outcome = bulkOutcome(op?.status);
  const now = new Date().toISOString();
  let patch: Partial<HistoryImportRow> & { updated_at: string };
  if (outcome === "esperar") {
    patch = { object_count: op?.objectCount != null ? Number(op.objectCount) : null, updated_at: now };
  } else if (outcome === "fallo") {
    patch = { status: "error", error: `Shopify no terminó el archivo (${op?.status ?? "?"}${op?.errorCode ? `, ${op.errorCode}` : ""}). Vuelve a traerlo.`, finished_at: now, updated_at: now };
  } else if (!op?.url) {
    patch = { status: "listo", object_count: 0, finished_at: now, updated_at: now };
  } else {
    patch = {
      status: "importando",
      url: op.url,
      file_size: op.fileSize != null ? Number(op.fileSize) : null,
      object_count: op.objectCount != null ? Number(op.objectCount) : null,
      bytes_done: 0,
      updated_at: now,
    };
  }
  const { data: updated } = await admin
    .from("shopify_history_imports")
    .update(patch)
    .eq("id", row.id)
    .eq("status", "preparando")
    .select(IMPORT_COLUMNS)
    .maybeSingle();
  return (updated as HistoryImportRow | null) ?? { ...row, ...patch };
}

/** Toma la tanda; null si otra pestaña la está leyendo. */
async function claim(admin: SupabaseClient, row: HistoryImportRow, now: Date): Promise<HistoryImportRow | null> {
  const { data } = await admin
    .from("shopify_history_imports")
    .update({ lease_until: new Date(now.getTime() + IMPORT_LEASE_MS).toISOString(), updated_at: now.toISOString() })
    .eq("id", row.id)
    .eq("status", "importando")
    .or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`)
    .select(IMPORT_COLUMNS)
    .maybeSingle();
  return (data as HistoryImportRow | null) ?? null;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Lee el archivo desde `bytes_done` hasta agotar el tiempo o el archivo, y
 * guarda por tandas. Corta siempre justo antes de un pedido (o cliente) nuevo,
 * y deja anotado ese byte: la próxima tanda sigue exactamente desde ahí.
 */
export async function readImportChunk(
  admin: SupabaseClient,
  row: HistoryImportRow,
  write: RowWriter,
  opts: { budgetMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<HistoryImportRow> {
  const nowMs = opts.now ?? Date.now;
  const started = nowMs();
  const budget = opts.budgetMs ?? IMPORT_BUDGET_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const offset = Number(row.bytes_done) || 0;

  const res = await doFetch(row.url!, { headers: offset > 0 ? { Range: `bytes=${offset}-` } : {} });
  if (res.status === 416) return finish(admin, row, { bytesDone: offset, records: 0, firstAt: null, lastAt: null, done: true });
  if (!res.ok || !res.body) {
    const expired = res.status === 403 || res.status === 404 || res.status === 410;
    throw new Error(expired ? "El archivo de Shopify venció. Vuelve a traerlo." : `No se pudo leer el archivo de Shopify (HTTP ${res.status}).`);
  }
  // Sin soporte de Range (200 en vez de 206), se saltan los bytes ya leídos.
  let skip = res.status === 200 && offset > 0 ? offset : 0;
  const reader = res.body.getReader();

  let carry: Uint8Array = new Uint8Array(0);
  let base = offset;
  let pending: JsonlLine[] = [];
  let pendingTop = 0;
  let records = 0;
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let stopAt: number | null = null;

  const flush = async () => {
    if (!pending.length) return;
    if (row.kind === "pedidos") {
      const { orders, orphans } = groupBulkOrders(pending);
      records += await write.orders(orders, row.id);
      if (orphans.size) await write.orphans(orphans);
      for (const o of orders) {
        if (!o.created_at) continue;
        if (!firstAt || o.created_at < firstAt) firstAt = o.created_at;
        if (!lastAt || o.created_at > lastAt) lastAt = o.created_at;
      }
    } else {
      const customers = pending.filter(isTopLevel).map((l) => mapBulkCustomer(l.value)).filter((c): c is HistoryCustomer => !!c);
      records += await write.customers(customers, row.id);
    }
    pending = [];
    pendingTop = 0;
  };
  const persist = async (bytesDone: number) => {
    const saved = await progress(admin, row, { bytesDone, records, firstAt, lastAt });
    records = 0;
    firstAt = null;
    lastAt = null;
    row = saved;
  };

  try {
    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      let chunk: Uint8Array = value;
      if (skip > 0) {
        if (chunk.length <= skip) {
          skip -= chunk.length;
          continue;
        }
        chunk = chunk.subarray(skip);
        skip = 0;
      }
      const buf = concat(carry, chunk);
      const { lines, rest } = splitJsonl(buf, base);
      base += buf.length - rest.length;
      carry = rest;
      for (const line of lines) {
        if (isTopLevel(line)) {
          if (nowMs() - started > budget) {
            stopAt = line.start;
            break outer;
          }
          if (pendingTop >= IMPORT_WRITE_BATCH) {
            await flush();
            await persist(line.start);
          }
          pendingTop++;
        }
        pending.push(line);
      }
    }
  } finally {
    if (stopAt !== null) await reader.cancel().catch(() => undefined);
  }

  if (stopAt !== null) {
    await flush();
    await persist(stopAt);
    return release(admin, row);
  }
  // Fin del archivo: la última línea puede no traer salto de línea.
  if (carry.length) {
    const tail = splitJsonl(concat(carry, new Uint8Array([0x0a])), base);
    pending.push(...tail.lines);
  }
  await flush();
  return finish(admin, row, { bytesDone: base + carry.length, records, firstAt, lastAt, done: true });
}

async function progress(
  admin: SupabaseClient,
  row: HistoryImportRow,
  delta: { bytesDone: number; records: number; firstAt: string | null; lastAt: string | null },
): Promise<HistoryImportRow> {
  const patch = {
    bytes_done: delta.bytesDone,
    records: (row.records ?? 0) + delta.records,
    first_at: [row.first_at, delta.firstAt].filter((d): d is string => !!d).sort()[0] ?? null,
    last_at: [row.last_at, delta.lastAt].filter((d): d is string => !!d).sort().at(-1) ?? null,
    // Una tanda que avanzó borra el aviso de la que falló antes.
    error: null,
    updated_at: new Date().toISOString(),
  };
  const { data } = await admin.from("shopify_history_imports").update(patch).eq("id", row.id).select(IMPORT_COLUMNS).maybeSingle();
  return (data as HistoryImportRow | null) ?? { ...row, ...patch };
}

async function release(admin: SupabaseClient, row: HistoryImportRow): Promise<HistoryImportRow> {
  const { data } = await admin
    .from("shopify_history_imports")
    .update({ lease_until: null, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .select(IMPORT_COLUMNS)
    .maybeSingle();
  return (data as HistoryImportRow | null) ?? { ...row, lease_until: null };
}

async function finish(
  admin: SupabaseClient,
  row: HistoryImportRow,
  delta: { bytesDone: number; records: number; firstAt: string | null; lastAt: string | null; done: true },
): Promise<HistoryImportRow> {
  const saved = await progress(admin, row, delta);
  const now = new Date().toISOString();
  const { data } = await admin
    .from("shopify_history_imports")
    .update({ status: "listo", lease_until: null, finished_at: now, updated_at: now })
    .eq("id", row.id)
    .select(IMPORT_COLUMNS)
    .maybeSingle();
  return (data as HistoryImportRow | null) ?? { ...saved, status: "listo", lease_until: null, finished_at: now };
}

/** Avanza una traída un paso: revisar a Shopify o leer una tanda. */
export async function advanceHistoryImport(
  admin: SupabaseClient,
  row: HistoryImportRow,
  write: RowWriter,
): Promise<HistoryImportRow & { busy?: boolean }> {
  if (row.status === "preparando") {
    row = await checkPreparing(admin, row);
    if (row.status !== "importando") return row;
  }
  if (row.status !== "importando") return row;
  const claimed = await claim(admin, row, new Date());
  if (!claimed) return { ...row, busy: true };
  try {
    return await readImportChunk(admin, claimed, write);
  } catch (cause) {
    const message = (cause as Error).message.slice(0, 1000);
    const expired = message.includes("venció");
    const now = new Date().toISOString();
    const { data } = await admin
      .from("shopify_history_imports")
      .update({ lease_until: null, updated_at: now, ...(expired ? { status: "error", error: message, finished_at: now } : { error: message }) })
      .eq("id", claimed.id)
      .select(IMPORT_COLUMNS)
      .maybeSingle();
    return (data as HistoryImportRow | null) ?? { ...claimed, error: message };
  }
}

export { mergeLineItems };
