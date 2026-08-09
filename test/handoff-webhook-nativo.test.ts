import { describe, it, expect } from "vitest";
import { classifyKapsoEvent, handoffDiscardSample, parseHandoffPayload } from "@/lib/kapso";

/**
 * El webhook NATIVO de plataforma de Kapso.
 *
 * Es el segundo emisor de handoffs y se descartaba entero: 68 el 2026-08-06 y 39
 * el 08-07, cada uno un cliente que escaló a humano y nunca subió a "Atender
 * ahora" — devolviendo 200, así que del lado de Kapso parecía entregado.
 *
 * El cuerpo de acá es el REAL, reconstruido de las claves que registró la
 * superficie de anomalías. Los valores son inventados; la FORMA no.
 */
const NATIVO = {
  channel: "whatsapp",
  event: "workflow.execution.handoff",
  handoff: { reason: "cliente pide humano", context_summary: "quiere cambiar la talla" },
  occurred_at: "2026-08-07T23:25:15Z",
  project_id: "proj_1",
  status: "completed",
  whatsapp_conversation_id: "31513f90-ffae-4c67-9a11-000000000001",
  workflow_execution_id: "wfe_1",
  workflow_id: "wf_1",
};

describe("webhook nativo de handoff de Kapso", () => {
  it("la conversación se lee de whatsapp_conversation_id", () => {
    // ESTE es el arreglo. Era la única identidad del cuerpo, y sin leerla
    // `applyHandoff` se quedaba sin nada con qué encontrar al cliente.
    expect(parseHandoffPayload(NATIVO).conversationId).toBe(
      "31513f90-ffae-4c67-9a11-000000000001",
    );
  });

  it("el cuerpo nativo ya NO queda sin identidad", () => {
    // La condición exacta que disparaba el descarte en applyHandoff: sin
    // teléfono, sin BSUID y sin conversación no hay a quién atender.
    const info = parseHandoffPayload(NATIVO);
    expect(info.phone ?? info.bsuid ?? info.conversationId).toBeTruthy();
  });

  it("el motivo y el contexto salen de `handoff`, no de la raíz", () => {
    // Sin esto el lead sube a la cola pero la asesora abre el drawer sin saber
    // para qué la llamaron, que es la mitad del valor de la cola.
    const info = parseHandoffPayload(NATIVO);
    expect(info.reason).toBe("cliente pide humano");
    expect(info.context).toBe("quiere cambiar la talla");
  });

  it("la clasificación ya era correcta: el fallo estaba en el parseo", () => {
    // Importa distinguirlo: durante un rato la hipótesis fue que estos eventos
    // ni siquiera eran handoffs y que sobraba la suscripción. Eran handoffs.
    expect(classifyKapsoEvent("workflow.execution.handoff", NATIVO)).toBe("handoff");
    expect(classifyKapsoEvent(null, NATIVO)).toBe("handoff");
  });

  it("no le quita prioridad al teléfono cuando los dos vienen", () => {
    // El teléfono empareja Y permite crear el lead; la conversación solo
    // encuentra uno que ya existe. Invertir el orden degradaría el caso normal.
    const info = parseHandoffPayload({ ...NATIVO, phone_number: "+51 999 888 777" });
    expect(info.phone).toBe("51999888777");
  });

  it("el emisor propio sigue funcionando igual", () => {
    // Guardia de regresión: `notify-team` y `check-coverage` mandan la forma
    // plana, que es por donde entra hoy la cola de "Atender ahora".
    const propio = {
      event: "workflow.execution.handoff",
      phone_number: "51999888777",
      conversation_id: "conv-propia",
      reason: "esperando respuesta",
    };
    const info = parseHandoffPayload(propio);
    expect(info.conversationId).toBe("conv-propia");
    expect(info.reason).toBe("esperando respuesta");
  });

  it("el sample ahora sí registra las claves de `handoff`", () => {
    // El hueco que dejó el primer informe: `reason: null` y nada que explicara
    // por qué. Sin esta línea el diagnóstico se quedaba a medio camino.
    const s = handoffDiscardSample(NATIVO, parseHandoffPayload(NATIVO), null);
    expect(s.clavesHandoff).toEqual(["context_summary", "reason"]);
  });

  it("un `handoff` con otras claves deja el motivo nulo pero NO pierde al cliente", () => {
    // Si Kapso nombra los campos de otra forma, lo caro es perder al cliente; el
    // motivo es recuperable. La conversación tiene que seguir saliendo.
    const otro = { ...NATIVO, handoff: { motivo: "x", resumen: "y" } };
    const info = parseHandoffPayload(otro);
    expect(info.reason).toBeNull();
    expect(info.conversationId).toBe("31513f90-ffae-4c67-9a11-000000000001");
  });
});
