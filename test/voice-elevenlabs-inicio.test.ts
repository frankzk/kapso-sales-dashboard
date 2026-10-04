import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ELEVENLABS_FICHA_VARS, buildFicha, elevenLabsInitiation } from "@/lib/voice-recovery";

const NOW = new Date("2026-10-03T16:00:00.000Z");
const ficha = (customerName: string | null) =>
  buildFicha(
    {
      storeName: "Kenku Peru",
      customerName,
      orderName: "#KP136687",
      lineItems: [{ title: "Nails Repairing – Sérum Tea Tree Ginger para Uñas (30ml)", quantity: 3 }],
      total: "178.00",
      district: "Huancayo",
      province: "Huancayo",
      address: "Óvalo de azapampa chilca",
      reference: "Al costado del óvalo",
      mode: "test",
    },
    NOW,
  );

describe("ficha precargada del Agente ElevenLabs (MOM §11.8)", () => {
  it("con ficha: todas las variables como texto y saludo con el nombre", () => {
    const out = elevenLabsInitiation(ficha("NORMA OLGA VILA"));
    expect(out.type).toBe("conversation_initiation_client_data");
    expect(Object.keys(out.dynamic_variables).sort()).toEqual([...ELEVENLABS_FICHA_VARS].sort());
    expect(Object.values(out.dynamic_variables).every((v) => typeof v === "string")).toBe(true);
    expect(out.dynamic_variables).toMatchObject({ encontrada: "si", nombre: "Norma", tienda: "Kenku", cantidad: "3", monto: "S/ 178" });
    expect(out.conversation_config_override.agent.first_message).toBe("Hola, buenas. ¿Hablo con Norma?");
  });

  it("sin nombre: pregunta con quién habla", () => {
    expect(elevenLabsInitiation(ficha(null)).conversation_config_override.agent.first_message).toBe(
      "Hola, buenas. ¿Con quién tengo el gusto?",
    );
  });

  it("sin ficha: todas las variables vacías, encontrada = no y saludo genérico", () => {
    const out = elevenLabsInitiation(null);
    expect(Object.keys(out.dynamic_variables).sort()).toEqual([...ELEVENLABS_FICHA_VARS].sort());
    expect(out.dynamic_variables.encontrada).toBe("no");
    expect(out.dynamic_variables.nombre).toBe("");
    expect(out.conversation_config_override.agent.first_message).toBe("Hola, buenas.");
  });
});

describe("guardas del webhook de inicio (código)", () => {
  const route = readFileSync(resolve(__dirname, "../app/api/voice/elevenlabs/inicio/route.ts"), "utf8");
  const identificar = readFileSync(resolve(__dirname, "../app/api/voice/tools/identificar_llamada/route.ts"), "utf8");

  it("autentica antes de leer nada y nunca falla sin variables", () => {
    expect(route.indexOf("voiceToolAuthorized(req)")).toBeLessThan(route.indexOf("createAdminSupabase()"));
    expect(route).toContain("catch (err)");
    expect(route.match(/elevenLabsInitiation\(null\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("deja la llamada en curso y marcada como precargada", () => {
    expect(route).toContain('status: "in_progress"');
    expect(route).toContain("ficha_precargada: true");
  });

  it("identificar_llamada solo entrega una llamada en curso si la abrió el inicio de ElevenLabs", () => {
    expect(identificar).toContain('pickOpenCall(open, "in_progress", opts)');
    expect(identificar).toContain("fichaPrecargada(admin, enCurso.call.id)");
  });
});
