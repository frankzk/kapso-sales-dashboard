// Una base falsa en memoria para las pruebas de la entrada de WooCommerce
// (test/woocommerce-*.test.ts). Aplica de verdad los filtros de cada lectura y
// escritura (`eq`, `in`, `is`, `match`, `gte`/`gt`/`lte`/`lt`, `limit`) y las
// claves únicas que usan estas rutas: `orders (store_id, shopify_order_id)`,
// `webhook_events (store_id, webhook_id)`, `sync_state (store_id, source)` y
// `order_events (order_id, operation_id, kind)` cuando hay `operation_id`,
// con el `ignoreDuplicates` de un upsert (ON CONFLICT DO NOTHING). Lo demás
// (orden, `range`, `not`, `or`) se acepta y no filtra: las pruebas no dependen
// de ello. `hangOn` deja una consulta sin contestar (una base que no responde).
//
// No es un archivo de pruebas (no termina en .test.ts): lo importan.

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Row = Record<string, any>;
export type DbError = { message: string; code?: string };
export interface DbOp {
  table: string;
  op: string;
  payload?: any;
  filters: [string, string, any][];
  cols?: string;
}

const UNIQUE: Record<string, string[]> = {
  orders: ["store_id", "shopify_order_id"],
  webhook_events: ["store_id", "webhook_id"],
  sync_state: ["store_id", "source"],
  // Los pedidos del bot (0277, MOM §38.13): el candado y el secreto de cada tienda.
  bot_order_requests: ["store_id", "request_id"],
  bot_order_secrets: ["store_id"],
  // Los hechos con clave (0122, `order_events_operation_kind_uniq`): índice
  // parcial, solo cuando `operation_id` no es null (ver abajo).
  order_events: ["order_id", "operation_id", "kind"],
};

let seq = 0;

/** Compara como Postgres lo haría con estos datos: números, fechas ISO o texto. Null si alguno falta. */
function compare(a: any, b: any): number | null {
  if (a == null || b == null) return null;
  const na = typeof a === "number" ? a : typeof a === "string" && a.trim() !== "" ? Number(a) : NaN;
  const nb = typeof b === "number" ? b : typeof b === "string" && b.trim() !== "" ? Number(b) : NaN;
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  const da = Date.parse(String(a));
  const db = Date.parse(String(b));
  if (Number.isFinite(da) && Number.isFinite(db)) return da - db;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function matches(row: Row, filters: [string, string, any][]): boolean {
  return filters.every(([m, col, val]) => {
    if (m === "eq") return String(row[col]) === String(val);
    if (m === "neq") return String(row[col]) !== String(val);
    if (m === "in") return (val as unknown[]).map(String).includes(String(row[col]));
    if (m === "is") return val === null ? row[col] == null : row[col] === val;
    if (m === "gte" || m === "gt" || m === "lte" || m === "lt") {
      const c = compare(row[col], val);
      if (c == null) return false;
      return m === "gte" ? c >= 0 : m === "gt" ? c > 0 : m === "lte" ? c <= 0 : c < 0;
    }
    return true;
  });
}

class FakeQuery {
  op = "select";
  payload: any;
  filters: [string, string, any][] = [];
  cols?: string;
  isSingle = false;
  limitN: number | null = null;
  returning = false;
  constructor(
    private db: FakeDb,
    private table: string,
  ) {}
  countOnly = false;
  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.cols = cols;
      // `{count: "exact", head: true}`: solo cuántas filas (los filtros `eq`/`in`/`is`).
      this.countOnly = Boolean(opts?.count && opts?.head);
    } else this.returning = true;
    return this;
  }
  insert(p: any) {
    this.op = "insert";
    this.payload = p;
    return this;
  }
  ignoreDuplicates = false;
  upsert(p: any, opts?: { ignoreDuplicates?: boolean }) {
    this.op = "upsert";
    this.payload = p;
    this.ignoreDuplicates = Boolean(opts?.ignoreDuplicates);
    return this;
  }
  update(p: any) {
    this.op = "update";
    this.payload = p;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(c: string, v: any) {
    this.filters.push(["eq", c, v]);
    return this;
  }
  neq(c: string, v: any) {
    this.filters.push(["neq", c, v]);
    return this;
  }
  in(c: string, v: any[]) {
    this.filters.push(["in", c, v]);
    return this;
  }
  is(c: string, v: any) {
    this.filters.push(["is", c, v]);
    return this;
  }
  match(obj: Row) {
    for (const [k, v] of Object.entries(obj)) this.filters.push(["eq", k, v]);
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  order() {
    return this;
  }
  range() {
    return this;
  }
  not() {
    return this;
  }
  or() {
    return this;
  }
  gte(c: string, v: any) {
    this.filters.push(["gte", c, v]);
    return this;
  }
  lte(c: string, v: any) {
    this.filters.push(["lte", c, v]);
    return this;
  }
  gt(c: string, v: any) {
    this.filters.push(["gt", c, v]);
    return this;
  }
  lt(c: string, v: any) {
    this.filters.push(["lt", c, v]);
    return this;
  }
  maybeSingle() {
    this.isSingle = true;
    return this;
  }
  single() {
    this.isSingle = true;
    return this;
  }
  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    if (this.db.hangOn?.(this.table, this.op, this.payload, this.filters)) {
      // Una base que no contesta: la consulta queda registrada y nunca resuelve.
      this.db.ops.push({ table: this.table, op: this.op, payload: this.payload, filters: this.filters, cols: this.cols });
      return new Promise(() => {});
    }
    return Promise.resolve()
      .then(() => this.exec())
      .then(resolve, reject);
  }
  exec(): { data: any; error: DbError | null } {
    this.db.ops.push({ table: this.table, op: this.op, payload: this.payload, filters: this.filters, cols: this.cols });
    const fail = this.db.failOn?.(this.table, this.op, this.payload, this.filters) ?? null;
    if (fail) return { data: null, error: fail };
    const rows = this.db.rows(this.table);
    if (this.op === "select") {
      let found = rows.filter((r) => matches(r, this.filters)).map((r) => ({ ...r }));
      if (this.countOnly) return { data: null, error: null, count: found.length } as { data: any; error: DbError | null };
      if (this.limitN != null) found = found.slice(0, this.limitN);
      return { data: this.isSingle ? (found[0] ?? null) : found, error: null };
    }
    if (this.op === "insert" || this.op === "upsert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      const keys = UNIQUE[this.table];
      for (const p of list) {
        // Una clave con algún valor null no choca (índice parcial `where … is not null`).
        const hit =
          keys && keys.every((k) => p[k] != null)
            ? rows.find((r) => keys.every((k) => String(r[k]) === String(p[k])))
            : undefined;
        if (hit) {
          if (this.op === "insert") return { data: null, error: { code: "23505", message: `duplicate key on ${this.table}` } };
          // ON CONFLICT DO NOTHING (`insertOrderIfAbsent`): la fila que ya estaba no se toca.
          if (!this.ignoreDuplicates) Object.assign(hit, p);
        } else {
          rows.push({ id: p.id ?? `${this.table}-${++seq}`, ...p });
        }
      }
      return { data: null, error: null };
    }
    if (this.op === "update") {
      const hit = rows.filter((r) => matches(r, this.filters));
      for (const r of hit) Object.assign(r, this.payload);
      return { data: this.returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
    }
    if (this.op === "delete") {
      const keep = rows.filter((r) => !matches(r, this.filters));
      this.db.tables[this.table] = keep;
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  ops: DbOp[] = [];
  rpcCalls: { name: string; args: any }[] = [];
  failOn: ((table: string, op: string, payload: any, filters: [string, string, any][]) => DbError | null) | null = null;
  /** true: esa consulta no contesta nunca. */
  hangOn: ((table: string, op: string, payload: any, filters: [string, string, any][]) => boolean) | null = null;
  constructor(seed: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(seed)) this.tables[t] = rows.map((r) => ({ ...r }));
  }
  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }
  from(table: string) {
    return new FakeQuery(this, table);
  }
  async rpc(name: string, args: any) {
    this.rpcCalls.push({ name, args });
    return { data: null, error: null };
  }
  /** Las operaciones de una tabla (y de un tipo, si se pide). */
  opsOn(table: string, op?: string): DbOp[] {
    return this.ops.filter((o) => o.table === table && (!op || o.op === op));
  }
  client(): any {
    return this;
  }
}
