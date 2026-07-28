// Fake permisivo de Supabase para los tests de `runStoreSync`.
//
// Recuerda los cursores de `sync_state`, apunta cada escritura en orden y
// registra las llamadas a RPC. Eso es justo lo que hace falta para comprobar
// las dos propiedades que sostienen el sync incremental: QUÉ se guarda y, sobre
// todo, EN QUÉ ORDEN — morir entre dos escrituras tiene que dejar trabajo
// repetido, nunca trabajo perdido.
//
// Es permisivo a propósito: cualquier método del builder que no importe para
// eso devuelve el propio builder, y una consulta sin resolver devuelve lista
// vacía. Así las etapas que no son el objeto del test corren de verdad sin
// tener que simularlas una a una.

export interface Recorded {
  source: string;
  cursor: string | null;
  status: string;
}

export function makeFakeAdmin(storeRow: Record<string, unknown>) {
  const cursors = new Map<string, string | null>();
  const writes: Recorded[] = [];
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];

  class Builder {
    filters: Record<string, unknown> = {};
    constructor(public table: string) {}
    select() {
      return this;
    }
    eq(k: string, v: unknown) {
      this.filters[k] = v;
      return this;
    }
    match(m: Record<string, unknown>) {
      Object.assign(this.filters, m);
      return this;
    }
    in() {
      return this;
    }
    is() {
      return this;
    }
    not() {
      return this;
    }
    neq() {
      return this;
    }
    limit() {
      return this;
    }
    order() {
      return this;
    }
    lt() {
      return this;
    }
    gte() {
      return this;
    }
    update() {
      return this;
    }
    insert() {
      return this;
    }
    delete() {
      return this;
    }
    upsert(payload: Record<string, unknown>) {
      if (this.table === "sync_state") {
        const source = payload.source as string;
        cursors.set(source, (payload.cursor as string | null) ?? null);
        writes.push({
          source,
          cursor: (payload.cursor as string | null) ?? null,
          status: payload.status as string,
        });
      }
      return this;
    }
    async single() {
      return this.table === "stores" ? { data: storeRow, error: null } : { data: null, error: null };
    }
    async maybeSingle() {
      if (this.table === "sync_state") {
        const source = this.filters.source as string;
        return { data: { cursor: cursors.get(source) ?? null }, error: null };
      }
      return { data: null, error: null };
    }
    then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
      return Promise.resolve({ data: [], error: null }).then(resolve);
    }
  }

  const admin = {
    from: (table: string) => new Builder(table),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: null, error: null };
    },
  };
  return { admin, writes, rpcCalls, cursors };
}

/** Pedido mínimo tal y como lo devuelve `fetchOrdersPage`. */
export const order = (id: string, createdAt: string, updatedAt: string) => ({
  store_id: "store-1",
  shopify_order_id: id,
  created_at: createdAt,
  updated_at: updatedAt,
  currency: "PEN",
  total_price: 100,
});
