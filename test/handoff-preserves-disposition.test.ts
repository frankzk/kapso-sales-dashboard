import { describe, it, expect } from "vitest";
import { applyHandoff } from "@/lib/leads-ingest";

// Un handoff del bot NO debe borrar la disposición que una asesora puso a mano.
// Importa sobre todo con handoffs de ALTO VOLUMEN (el watchdog de "clientes
// esperando respuesta", que dispara cada vez que alguien escribe y el bot no
// contesta en 3 min): sin este resguardo, un "Volver a llamar" se degradaría a
// "casi_cierra" y un "Ya compró en otro lado" se resucitaría como lead caliente.
// La excepción son los handoffs de pago/logística, que SÍ deben mover el lead a
// la pestaña Yape/Shalom.

const STORE = "store-1";
const PHONE = "51999888777";

type Row = Record<string, any>;

/** Fake mínimo de Supabase para applyHandoff: resuelve el lead existente y
 *  registra el upsert. applyHandoff hace DOS selects sobre `leads`
 *  ("status, has_order" y luego "id"), que se distinguen por las columnas. */
class FakeSupabase {
  upserts: Row[] = [];
  callNotes: Row[] = [];
  constructor(private existing: Row | null) {}
  from(table: string) {
    return new FakeBuilder(table, this);
  }
  exec(b: FakeBuilder): { data: any; error: any } {
    if (b.table === "leads" && b.op === "select") {
      // segundo select: solo el id, para el registro en lead_calls
      if (b.cols === "id") return { data: this.existing ? { id: "lead-1" } : null, error: null };
      return { data: this.existing, error: null };
    }
    if (b.table === "leads" && (b.op === "upsert" || b.op === "update")) {
      this.upserts.push(b.payload);
      return { data: null, error: null };
    }
    if (b.table === "lead_calls" && b.op === "insert") {
      this.callNotes.push(b.payload);
      return { data: null, error: null };
    }
    return { data: null, error: null };
  }
}

class FakeBuilder {
  op: string | null = null;
  payload: any;
  cols = "";
  constructor(public table: string, public store: FakeSupabase) {}
  select(cols?: string) {
    this.op = this.op ?? "select";
    this.cols = cols ?? "";
    return this;
  }
  insert(p: any) {
    this.op = "insert";
    this.payload = p;
    return this;
  }
  upsert(p: any) {
    this.op = "upsert";
    this.payload = p;
    return this;
  }
  update(p: any) {
    this.op = "update";
    this.payload = p;
    return this;
  }
  eq() {
    return this;
  }
  maybeSingle() {
    return this;
  }
  then(resolve: (v: any) => any, reject?: (e: any) => any) {
    return Promise.resolve(this.store.exec(this)).then(resolve, reject);
  }
}

const body = (reason: string, context = "el cliente espera respuesta") => ({
  event: "workflow.execution.handoff",
  phone_number: PHONE,
  reason,
  context_summary: context,
});

async function run(existing: Row | null, reason: string, context?: string) {
  const sb = new FakeSupabase(existing);
  const res = await applyHandoff(sb as any, STORE, body(reason, context));
  // Todos los caminos de applyHandoff escriben en `leads` (upsert o update).
  const row = sb.upserts[0];
  if (!row) throw new Error("applyHandoff no escribió en leads");
  return { sb, res, row };
}

describe("applyHandoff: preserva la disposición manual de la asesora", () => {
  it("un handoff genérico NO pisa un estado manual ('volver_a_llamar')", async () => {
    const { row } = await run({ status: "volver_a_llamar", has_order: false }, "esperando respuesta");
    // No toca el estado de la asesora…
    expect(row).not.toHaveProperty("status");
    expect(row).not.toHaveProperty("category");
    // …pero sí lo sube a "Atender ahora".
    expect(row.needs_attention).toBe(true);
    expect(row.handoff_at).toEqual(expect.any(String));
  });

  it("un handoff genérico NO resucita un lead perdido ('ya_compro_otro_lado')", async () => {
    const { row } = await run({ status: "ya_compro_otro_lado", has_order: false }, "esperando respuesta");
    expect(row).not.toHaveProperty("status");
    expect(row).not.toHaveProperty("category"); // seguiría siendo 'lost', no pasa a 'hot'
  });

  it("registra la nota del sistema con el estado REAL conservado, no el derivado", async () => {
    const { sb } = await run({ status: "volver_a_llamar", has_order: false }, "esperando respuesta");
    expect(sb.callNotes[0]!.new_status).toBe("volver_a_llamar");
  });

  it("un handoff de PAGO sí manda: mueve el lead a Yape/Shalom aunque haya estado manual", async () => {
    const { row } = await run({ status: "no_responde", has_order: false }, "validacion_pago");
    expect(row.status).toBe("yape_por_verificar");
    expect(row.category).toBe("hot");
  });

  it("un motivo con sabor a pago en el CONTEXTO también manda sobre el estado manual", async () => {
    const { row } = await run({ status: "buzon", has_order: false }, "consulta", "mandó el voucher del yape");
    expect(row.status).toBe("yape_por_verificar");
  });

  it("un estado AUTO ('nuevo') sí se re-deriva — comportamiento previo intacto", async () => {
    const { row } = await run({ status: "nuevo", has_order: false }, "esperando respuesta");
    expect(row.status).toBe("casi_cierra");
    expect(row.category).toBe("hot");
  });

  it("un lead que no existe se crea con el estado derivado", async () => {
    const { row } = await run(null, "esperando respuesta");
    expect(row.status).toBe("casi_cierra");
    expect(row.needs_attention).toBe(true);
    expect(row.phone).toBe(PHONE);
  });

  // Un cliente que YA COMPRÓ y está esperando respuesta necesita atención igual
  // (post-venta, problema con el envío, quiere agregar algo). Antes esta rama
  // guardaba el contexto pero no marcaba needs_attention, así que el handoff
  // quedaba registrado y el lead nunca aparecía en la cola — se perdía en
  // silencio. Pasó en producción con leads en `pedido_generado`.
  it("un lead ya ganado conserva su estado PERO sube a 'Atender ahora'", async () => {
    const { row } = await run({ status: "pedido_generado", has_order: true }, "esperando respuesta");
    expect(row).not.toHaveProperty("status"); // sigue siendo un pedido generado
    expect(row).not.toHaveProperty("category");
    expect(row.needs_attention).toBe(true); // …pero alguien lo tiene que atender
    expect(row.handoff_at).toEqual(expect.any(String));
  });

  it("un lead ya ganado sin motivo de handoff no se marca para atención", async () => {
    const { row } = await run({ status: "pedido_generado", has_order: true }, "");
    expect(row.needs_attention).toBe(false);
  });
});
