import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mismaDireccion } from "@/lib/voice-recovery";

// Casos reales del 25-09-2026: el agente mandó `direccion_confirmada` leyendo
// la de la ficha, aunque no había cambiado.
describe("mismaDireccion (salida Swayp del agente, §11.8)", () => {
  it("la dirección leída tal cual de la ficha es la misma", () => {
    expect(
      mismaDireccion(
        "Sorana los ángeles zona uno mzD lote 8",
        "Sorana los ángeles zona uno mzD lote 8",
        "Dos cuadras de colegio sorana",
      ),
    ).toBe(true);
  });

  it("con la referencia pegada, también", () => {
    expect(
      mismaDireccion(
        "Horacio Zeballos Games, frente al colegio Gran Maestro, por el penal",
        "Horacio Zeballos Games, frente al colegio Gran Maestro, por el penal",
        "Frente al colegio Gran Maestro, por el penal",
      ),
    ).toBe(true);
    expect(mismaDireccion("Horacio Zeballos Games frente al colegio Gran Maestro", "Horacio Zeballos Games", "Frente al colegio Gran Maestro, por el penal")).toBe(true);
  });

  it("tildes, signos, números dichos y abreviaturas no la cambian", () => {
    expect(mismaDireccion("Sorana Los Angeles zona 1 Mz. D Lt. 8", "Sorana los ángeles zona uno manzana D lote 8")).toBe(true);
  });

  it("sin dirección dicha, se usa la del pedido", () => {
    expect(mismaDireccion(null, "Av. Ejército 123")).toBe(true);
    expect(mismaDireccion("  ", "Av. Ejército 123")).toBe(true);
  });

  it("otra calle o otro número NO es la misma: no se crea la salida", () => {
    expect(mismaDireccion("Av. Ejército 456", "Av. Ejército 123")).toBe(false);
    expect(mismaDireccion("Calle Mercaderes 200, Cercado", "Sorana los ángeles zona uno mzD lote 8", "Dos cuadras de colegio sorana")).toBe(false);
  });

  it("si el pedido no tiene dirección y la clienta dictó una, no se adivina", () => {
    expect(mismaDireccion("Av. Ejército 123", null)).toBe(false);
  });
});

describe("registrar_gestion crea la salida Swayp solo cuando corresponde (§11.8)", () => {
  const route = readFileSync(resolve(process.cwd(), "app/api/voice/tools/registrar_gestion/route.ts"), "utf8");
  const server = readFileSync(resolve(process.cwd(), "lib/voice-recovery-server.ts"), "utf8");
  const agente = server.slice(server.indexOf("export async function crearSalidaSwaypDelAgente("));

  it("solo en modo real, solo con un «confirmado», y después de responder", () => {
    expect(route).toContain(
      'if (call.mode === "real" && action.kind === "attempt" && action.result === "confirmado") {',
    );
    expect(route).toContain("after(() =>");
    // Después de escribir la gestión, nunca antes: sin gestión no hay salida.
    expect(route.indexOf("crearSalidaSwaypDelAgente(admin")).toBeGreaterThan(route.indexOf("if (writeError) return"));
  });

  it("reclama la llamada ANTES de pedir el número a Swayp: un solo paquete por llamada", () => {
    expect(agente.indexOf('guardar({ estado: "creando" }, true)')).toBeGreaterThan(-1);
    expect(agente.indexOf('guardar({ estado: "creando" }, true)')).toBeLessThan(agente.indexOf("reenviarGuiaAnulada("));
    expect(agente).toContain('q.is("outcome_payload->salida_swayp", null)');
  });

  it("no crea nada si la dirección dicha no es la del pedido", () => {
    expect(agente.indexOf("mismaDireccion(")).toBeLessThan(agente.indexOf("reenviarGuiaAnulada("));
  });

  it("el actor es el agente, no una persona", () => {
    expect(agente).toContain("{ userId: null, storeId: call.store_id }");
  });
});

describe("el barrido recoge los aceptados sin salida pedida (§11.8)", () => {
  const cron = readFileSync(resolve(process.cwd(), "app/api/cron/voice-recovery/route.ts"), "utf8");
  const server = readFileSync(resolve(process.cwd(), "lib/voice-recovery-server.ts"), "utf8");
  const pendientes = server.slice(server.indexOf("export async function salidasSwaypPendientes("));

  it("solo llamadas reales, «confirma» con resultado confirmado, sin intento previo", () => {
    expect(pendientes).toContain('.eq("mode", "real")');
    expect(pendientes).toContain('.eq("outcome", "confirma")');
    expect(pendientes).toContain('.is("outcome_payload->salida_swayp", null)');
    expect(pendientes).toContain('p.resultado !== "confirmado"');
  });

  it("pasa por la misma función que el agente, con su reclamación de una sola vez", () => {
    expect(pendientes).toContain("await crearSalidaSwaypDelAgente(admin, row,");
  });

  it("el modo de prueba (dry) no crea nada", () => {
    expect(cron).toContain("const salidas = dry ? [] : await salidasSwaypPendientes(admin, now);");
  });
});

describe("la gestión del agente también queda en la guía que muestra Envíos (§11.8)", () => {
  const server = readFileSync(resolve(process.cwd(), "lib/voice-recovery-server.ts"), "utf8");
  const write = server.slice(server.indexOf("export async function writeVoiceAttempt("));
  const nota = server.slice(server.indexOf("async function noteOnRecoveryGuide("));

  it("después de escribir el intento en el pedido, y solo si se escribió", () => {
    const cuerpo = write.slice(0, write.indexOf("\n}\n"));
    expect(cuerpo.indexOf("if (error) return error.message;")).toBeLessThan(cuerpo.indexOf("noteOnRecoveryGuide("));
  });

  it("como una llamada sobre la guía anulada, sin actor humano y con fecha pactada si la hay", () => {
    expect(nota).toContain('.eq("delivery_status", "anulado")');
    expect(nota).toContain('from("shipment_calls").insert(');
    expect(nota).toContain("agent: null");
    expect(nota).toContain('kind: "call"');
    expect(nota).toContain("next_followup_at: followup");
  });
});
