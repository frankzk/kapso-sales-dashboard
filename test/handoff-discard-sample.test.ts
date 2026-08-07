import { describe, it, expect } from "vitest";
import { handoffDiscardSample, parseHandoffPayload } from "@/lib/kapso";

/**
 * Qué se guarda de un handoff descartado.
 *
 * Esto no es un adorno del informe: el 2026-08-07 se descartaron 68 handoffs
 * (62 en Kenku, 6 en Aurela) y el sample de entonces —`{ reason }` a secas—
 * decía `null` en los tres casos, que es exactamente lo que ninguna de las
 * cuatro funciones de Kapso puede mandar. Con eso no se podía distinguir "ruido
 * de eventos que nunca fueron handoff" de "68 clientes al día que no suben a
 * Atender ahora", y son decisiones opuestas.
 */

const info = (body: any) => parseHandoffPayload(body);
const sample = (body: any, header?: string | null) =>
  handoffDiscardSample(body, info(body), header);

describe("handoffDiscardSample", () => {
  it("nombra al emisor por el evento del header aunque el cuerpo no lo traiga", () => {
    // El caso que motivó todo: cuerpo sin `event` y motivo vacío. El header es
    // lo único que queda, y las cuatro funciones propias sí ponen `event` en el
    // cuerpo — así que un evento que solo viene por header ya dice "no es una
    // de las nuestras".
    const s = sample({ execution: { id: "e1" } }, "workflow.execution.completed");
    expect(s.event).toBe("workflow.execution.completed");
  });

  it("el header manda sobre el cuerpo, igual que en classifyKapsoEvent", () => {
    // Si divergieran, el sample culparía a un emisor y el enrutado habría hecho
    // caso a otro — y el diagnóstico saldría al revés.
    const s = sample({ event: "conversation.waiting" }, "workflow.execution.handoff");
    expect(s.event).toBe("workflow.execution.handoff");
  });

  it("sin header, cae al `event` del cuerpo — así postean las funciones propias", () => {
    expect(sample({ event: "conversation.waiting" }).event).toBe("conversation.waiting");
    expect(sample({ type: "workflow.execution.handoff" }).event).toBe(
      "workflow.execution.handoff",
    );
  });

  it("NUNCA guarda valores del cuerpo, solo sus claves", () => {
    // `ingest_anomalies` la lee cualquier miembro de la tienda por RLS (0107), y
    // un cuerpo de handoff lleva teléfono, nombre y el resumen de la
    // conversación. Guardar el cuerpo "para diagnosticar" convertiría la tabla
    // de diagnóstico en una fuga. Además los valores no aportan: lo que
    // identifica al emisor es la FORMA.
    const s = sample({
      execution: { id: "exec-1" },
      cliente: { phone_number: "51999888777", contact_name: "Vanessa", dni: "70123456" },
      context_summary: "quiere devolver el pedido, vive en Los Olivos",
    });
    const serializado = JSON.stringify(s);
    for (const secreto of ["51999888777", "Vanessa", "70123456", "Los Olivos", "exec-1"]) {
      expect(serializado).not.toContain(secreto);
    }
    // Y sin embargo la forma queda registrada.
    expect(s.claves).toContain("cliente");
    expect(s.claves).toContain("execution");
  });

  it("separa las dos hipótesis que llevan a decisiones opuestas", () => {
    // (a) Ruido: un evento de ejecución que nunca fue handoff. `classifyKapsoEvent`
    // lo manda acá solo porque ve `body.execution`. No se pierde ningún cliente.
    const ruido = sample(
      { execution: { id: "e1", status: "completed", workflow_id: "w1" } },
      "workflow.execution.completed",
    );
    // (b) Handoff real con una forma que no sabemos leer: SÍ se pierde un cliente.
    const handoffReal = sample(
      { data: { customer: {}, handoff: {} }, context_summary: "pide humano" },
      "workflow.execution.handoff",
    );
    expect(ruido.event).not.toBe(handoffReal.event);
    expect(ruido.clavesExec).toEqual(["id", "status", "workflow_id"]);
    expect(handoffReal.clavesData).toEqual(["customer", "handoff"]);
  });

  it("conserva el motivo cuando sí viene — no lo reemplaza, lo acompaña", () => {
    // El motivo seguía siendo el discriminador más directo cuando existe: cada
    // función de Kapso codifica el suyo (`bot_silent`, `esperando respuesta`).
    const s = sample({ reason: "bot_silent" });
    expect(s.reason).toBe("bot_silent");
  });

  it("no se rompe con cuerpos que no son objetos", () => {
    // La ruta hace `req.json()`, así que un cuerpo válido puede ser `null`, un
    // arreglo o un número. Que la instrumentación lance acá sería el peor caso:
    // rompería el webhook que intenta observar.
    for (const raro of [null, undefined, [], "texto", 42]) {
      expect(() => sample(raro)).not.toThrow();
      expect(sample(raro).claves).toEqual([]);
    }
  });

  it("un arreglo no se confunde con un objeto de claves", () => {
    // `Object.keys([a,b])` da ["0","1"]: índices disfrazados de nombres de campo,
    // que en el informe se leerían como una forma de cuerpo que no existe.
    expect(sample({ data: ["a", "b"] }).clavesData).toEqual([]);
  });

  it("acota el tamaño: es una tabla de informe, no un log", () => {
    const gordo: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) gordo[`campo_${i}`] = i;
    expect((sample(gordo).claves as string[]).length).toBe(12);
    expect(String(sample({}, "x".repeat(200)).event)).toHaveLength(60);
  });

  it("ordena las claves para que dos entregas iguales se vean iguales", () => {
    // Sin orden estable, el mismo emisor produciría samples distintos según cómo
    // serializó el cuerpo, y compararlos entre días sería imposible.
    expect(sample({ b: 1, a: 2, c: 3 }).claves).toEqual(["a", "b", "c"]);
  });
});
