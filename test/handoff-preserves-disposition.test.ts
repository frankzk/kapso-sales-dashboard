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
  /** Opciones del upsert (el `onConflict`), en paralelo a `upserts`. */
  upsertOpts: any[] = [];
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
      this.upsertOpts.push(b.opts ?? null);
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
  opts: any = null;
  upsert(p: any, opts?: any) {
    this.op = "upsert";
    this.payload = p;
    this.opts = opts ?? null;
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

  // El notify-team de Aurela postea también en el flujo de voucher, que no manda
  // `reason`. Sin motivo no hay señal de clasificación, así que un POST espurio no
  // debe degradar a "nuevo" un lead que ya venía trabajado.
  it("un handoff SIN motivo no reclasifica un lead existente", async () => {
    const { row } = await run({ status: "casi_cierra", has_order: false }, "");
    expect(row).not.toHaveProperty("status");
    expect(row).not.toHaveProperty("category");
    expect(row.needs_attention).toBe(false); // sin motivo tampoco sube a la cola
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

// ---------------------------------------------------------------------------
// 0105 — el cliente sin teléfono.
//
// Meta empezó a entregar conversaciones sin número (el cliente adoptó un
// username). Antes `applyHandoff` exigía teléfono y devolvía "no-phone", así que
// esos leads existían en la cola normal pero NUNCA subían a "Atender ahora"
// cuando el bot escalaba — justo el caso más urgente de todos.
// ---------------------------------------------------------------------------

const BSUID = "PE.1595605215510035";

/** Payload de handoff tal como llega sin número: la identidad viaja dentro del
 *  mismo objeto `conversation` que traía el teléfono. */
const bodySinTelefono = (reason: string) => ({
  event: "workflow.execution.handoff",
  conversation: { id: "conv-9", business_scoped_user_id: BSUID, username: "cfloresw13" },
  reason,
  context_summary: "el cliente espera respuesta",
});

describe("applyHandoff: leads sin teléfono (0105)", () => {
  it("un handoff sin número YA NO se descarta si trae BSUID", async () => {
    const sb = new FakeSupabase(null);
    const res = await applyHandoff(sb as any, STORE, bodySinTelefono("esperando respuesta"));
    expect(res.ok).toBe(true);
    expect(sb.upserts[0]).toBeTruthy();
  });

  it("escribe la identidad nueva y deja el teléfono en null", async () => {
    const sb = new FakeSupabase(null);
    await applyHandoff(sb as any, STORE, bodySinTelefono("esperando respuesta"));
    const row = sb.upserts[0]!;
    // La columna NO se escribe (antes se mandaba `null` explícito). En un INSERT
    // el valor por defecto ya es null, y en un UPDATE no tocarla es lo que evita
    // borrarle el teléfono a un lead que sí lo tenía.
    expect(row).not.toHaveProperty("phone");
    expect(row.bsuid).toBe(BSUID);
    expect(row.username).toBe("cfloresw13");
    // Y sube a la cola, que es el punto de todo esto.
    expect(row.needs_attention).toBe(true);
  });

  it("empareja por (store_id, bsuid), no por teléfono", async () => {
    // Lo importante del cambio. Con `store_id,phone` este upsert no colisionaría
    // nunca consigo mismo —los NULL son distintos entre sí en Postgres— y cada
    // handoff del watchdog crearía OTRO lead de la misma persona. El watchdog
    // dispara cada vez que alguien escribe y el bot no contesta en 3 minutos.
    const sb = new FakeSupabase(null);
    await applyHandoff(sb as any, STORE, bodySinTelefono("esperando respuesta"));
    expect(sb.upsertOpts[0]).toEqual({ onConflict: "store_id,bsuid" });
  });

  it("con teléfono sigue emparejando por (store_id, phone)", async () => {
    // Guardia de regresión: el camino de siempre, que es el 96% del volumen.
    const { sb } = await run(null, "esperando respuesta");
    expect(sb.upsertOpts[0]).toEqual({ onConflict: "store_id,phone" });
  });

  it("sin NINGUNA identidad sigue descartando, y sin escribir nada", async () => {
    const sb = new FakeSupabase(null);
    const res = await applyHandoff(sb as any, STORE, {
      event: "workflow.execution.handoff",
      reason: "esperando respuesta",
    });
    expect(res).toEqual({ ok: false, reason: "no-identity" });
    expect(sb.upserts).toHaveLength(0);
  });

  it("preserva la disposición manual igual que con teléfono", async () => {
    // El resguardo ganado con los handoffs de alto volumen no puede depender de
    // por qué columna se identifique al lead.
    const sb = new FakeSupabase({ status: "volver_a_llamar", has_order: false });
    await applyHandoff(sb as any, STORE, bodySinTelefono("esperando respuesta"));
    const row = sb.upserts[0]!;
    expect(row).not.toHaveProperty("status");
    expect(row.needs_attention).toBe(true);
  });

  it("un lead ya ganado sin teléfono también sube a Atender ahora", async () => {
    // La rama `has_order` hace un UPDATE, no un upsert: si su filtro se hubiera
    // quedado en `phone` habría actualizado CERO filas, en silencio.
    const sb = new FakeSupabase({ status: "pedido_generado", has_order: true });
    const res = await applyHandoff(sb as any, STORE, bodySinTelefono("consulta"));
    expect(res.ok).toBe(true);
    expect(sb.upserts[0]!.needs_attention).toBe(true);
    expect(sb.upserts[0]).not.toHaveProperty("status");
  });
});

// ---------------------------------------------------------------------------
// Emparejar por conversación — el caso que encontró la superficie de anomalías
// el día que se encendió: un aviso del watchdog ("esperando respuesta") llegó
// con `conversationId` pero sin teléfono ni BSUID, y se descartaba. Un cliente
// esperando que nunca subía a "Atender ahora", con el webhook respondiendo 200.
// ---------------------------------------------------------------------------

const bodySoloConversacion = (reason: string) => ({
  event: "workflow.execution.handoff",
  conversation: { id: "31513f90-ffae-4c67" },
  reason,
  context_summary: "el cliente espera respuesta",
});

describe("applyHandoff: emparejar por conversación", () => {
  it("un lead conocido por su conversación SÍ sube a Atender ahora", async () => {
    const sb = new FakeSupabase({ status: "volver_a_llamar", has_order: false });
    const res = await applyHandoff(sb as any, STORE, bodySoloConversacion("esperando respuesta"));
    expect(res.ok).toBe(true);
    expect(sb.upserts[0]!.needs_attention).toBe(true);
  });

  it("NO le borra el teléfono al lead que empareja", async () => {
    // El riesgo real de este camino. El lead casi siempre TIENE teléfono y el
    // payload no lo trae; un `phone: null` en el update lo dejaría sin poder
    // llamar y sin poder crear guía. Lo mismo con el hilo de la conversación.
    const sb = new FakeSupabase({ status: "nuevo", has_order: false });
    await applyHandoff(sb as any, STORE, bodySoloConversacion("esperando respuesta"));
    const row = sb.upserts[0]!;
    expect(row).not.toHaveProperty("phone");
    expect(row).not.toHaveProperty("bsuid");
  });

  it("escribe con UPDATE, no con upsert", async () => {
    // Un upsert por `kapso_conversation_id` no tiene restricción única que le
    // sirva de árbitro: PostgREST fallaría con "no unique or exclusion
    // constraint matching the ON CONFLICT specification", y solo en producción.
    const sb = new FakeSupabase({ status: "nuevo", has_order: false });
    await applyHandoff(sb as any, STORE, bodySoloConversacion("esperando respuesta"));
    expect(sb.upsertOpts[0]).toBeNull(); // un update no lleva onConflict
  });

  it("una conversación que ningún lead tiene se separa de 'sin identidad'", async () => {
    // Son dos problemas distintos: este se arregla solo cuando el sync cree el
    // lead; el otro no se arregla nunca. Mezclarlos en un mismo contador haría
    // imposible saber cuál de los dos está subiendo.
    const sb = new FakeSupabase(null);
    const res = await applyHandoff(sb as any, STORE, bodySoloConversacion("esperando respuesta"));
    expect(res).toEqual({ ok: false, reason: "unknown-conversation" });
    expect(sb.upserts).toHaveLength(0);
  });

  it("sin conversación NI identidad sigue siendo 'no-identity'", async () => {
    const sb = new FakeSupabase(null);
    const res = await applyHandoff(sb as any, STORE, {
      event: "workflow.execution.handoff",
      reason: "esperando respuesta",
    });
    expect(res).toEqual({ ok: false, reason: "no-identity" });
  });

  it("con teléfono NO usa el camino de la conversación", async () => {
    // Guardia de regresión: el 96 % del volumen sigue emparejando por número y
    // creando el lead si no existe.
    const { sb } = await run(null, "esperando respuesta");
    expect(sb.upsertOpts[0]).toEqual({ onConflict: "store_id,phone" });
    expect(sb.upserts[0]!.phone).toBe(PHONE);
  });
});
