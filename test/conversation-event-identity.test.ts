import { describe, it, expect } from "vitest";
import { ingestConversationEvent } from "@/lib/leads-ingest";

/**
 * `ingestConversationEvent` con un cliente SIN TELÉFONO (0105).
 *
 * El fallo que esto cubre es silencioso y caro: la función buscaba el lead con
 * `.eq("phone", seed.phone)`, y desde que un seed puede traer `phone: null` ese
 * null viajaba a PostgREST, que filtra por la CADENA "null". El lead existente
 * nunca aparecía, `existing` quedaba en null y el estado se volvía a derivar
 * desde cero — pisando la disposición que la asesora había puesto a mano, que es
 * justo lo que el resto de la función protege. Sin error en ningún log.
 */

const STORE = "store-1";
const BSUID = "PE.1595605215510035";

type Row = Record<string, any>;

/** Fake mínimo: un lead existente y el registro de lo que se escribe. */
class FakeSupabase {
  upserts: Row[] = [];
  upsertOpts: any[] = [];
  /** Filtros aplicados al select de `leads`, para poder afirmar por dónde buscó. */
  leadFilters: [string, any][] = [];
  constructor(private existingLead: Row | null) {}
  from(table: string) {
    return new FakeBuilder(table, this);
  }
  exec(b: FakeBuilder): { data: any; error: any } {
    if (b.table === "leads" && b.op === "select") {
      this.leadFilters = b.filters;
      // El fake RESPETA los filtros. Es lo único que hace útil al test de la
      // disposición: si devolviera el lead pase lo que pase, un filtro por un
      // teléfono nulo pareceria funcionar y el fallo real quedaria invisible.
      if (!this.existingLead) return { data: null, error: null };
      const matches = b.filters.every(([col, val]) => {
        if (col === "store_id") return true;
        // Clave para que el test sirva: un filtro con valor nulo NO empareja
        // nunca, ni siquiera contra una columna nula. PostgREST lo serializa
        // como `col=eq.null` y en SQL eso no es "IS NULL": no devuelve la fila.
        // Un fake que comparara `null === null` daría por bueno el código roto.
        if (val === null || val === undefined) return false;
        return this.existingLead![col] === val;
      });
      return { data: matches ? this.existingLead : null, error: null };
    }
    if (b.table === "leads" && b.op === "upsert") {
      this.upserts.push(b.payload);
      this.upsertOpts.push(b.opts ?? null);
      return { data: null, error: null };
    }
    if (b.table === "orders") throw new Error("no debe consultar pedidos sin teléfono");
    return { data: null, error: null };
  }
}

class FakeBuilder {
  op: string | null = null;
  payload: any;
  opts: any = null;
  filters: [string, any][] = [];
  constructor(
    public table: string,
    public store: FakeSupabase,
  ) {}
  select() {
    this.op = this.op ?? "select";
    return this;
  }
  upsert(p: any, opts?: any) {
    this.op = "upsert";
    this.payload = p;
    this.opts = opts ?? null;
    return this;
  }
  eq(col: string, val: any) {
    this.filters.push([col, val]);
    return this;
  }
  is() {
    return this;
  }
  limit() {
    return this;
  }
  maybeSingle() {
    return this;
  }
  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    return Promise.resolve(this.store.exec(this)).then(resolve, reject);
  }
}

const body = () => ({
  event: "whatsapp.conversation.ended",
  conversation: {
    id: "conv-9",
    business_scoped_user_id: BSUID,
    username: "cfloresw13",
    last_active_at: "2026-08-05T18:00:00Z",
  },
});

describe("ingestConversationEvent: cliente sin teléfono (0105)", () => {
  it("busca el lead por bsuid, no por un teléfono nulo", async () => {
    const sb = new FakeSupabase(null);
    await ingestConversationEvent(sb as any, STORE, body());
    const cols = sb.leadFilters.map(([c]) => c);
    expect(cols).toContain("bsuid");
    expect(cols).not.toContain("phone");
    // Y nunca con un valor nulo: PostgREST lo serializaría como la cadena "null".
    for (const [, val] of sb.leadFilters) expect(val).not.toBeNull();
  });

  it("NO pisa la disposición manual de la asesora", async () => {
    // El daño real del fallo. Con el lead invisible, `existing` era null y el
    // estado se re-derivaba: un "Volver a llamar" se degradaba solo.
    const sb = new FakeSupabase({
      phone: null,
      bsuid: BSUID,
      status: "volver_a_llamar",
      handoff_reason: null,
      has_order: false,
    });
    await ingestConversationEvent(sb as any, STORE, body());
    const row = sb.upserts[0]!;
    expect(row).not.toHaveProperty("status");
    expect(row).not.toHaveProperty("category");
  });

  it("crea el lead con la identidad nueva y sin teléfono", async () => {
    const sb = new FakeSupabase(null);
    await ingestConversationEvent(sb as any, STORE, body());
    const row = sb.upserts[0]!;
    expect(row.phone).toBeNull();
    expect(row.bsuid).toBe(BSUID);
    expect(sb.upsertOpts[0]).toEqual({ onConflict: "store_id,bsuid" });
  });

  it("sin ninguna identidad no escribe nada", async () => {
    const sb = new FakeSupabase(null);
    const res = await ingestConversationEvent(sb as any, STORE, {
      event: "whatsapp.conversation.ended",
      conversation: { id: "conv-x" },
    });
    expect(res).toEqual({ ok: false, reason: "no-identity" });
    expect(sb.upserts).toHaveLength(0);
  });
});
