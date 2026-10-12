// El agente de voz para leads está escrito en tres sitios que nadie compila
// juntos: el MOM (§33, las reglas), `docs/voz-leads-agente.md` (lo que se pega
// en la consola de ElevenLabs) y la migración 0247 (lo que la base acepta).
// Ninguno falla solo si se separa del código: un código de exclusión que el MOM
// no nombra, una variable que el prompt usa y Kapta no manda (ElevenLabs no
// arranca la conversación), un `enum` de la tool que el registro no acepta (el
// agente registra y Kapta responde «resultado debe ser uno de…» en plena
// llamada). Estas pruebas los atan al código que de verdad corre.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VOICE_LEAD_LIMITS } from "@/lib/store-settings";
import {
  LEAD_VOICE_EXCLUSIONS,
  LEAD_VOICE_EXPERIMENT,
  LEAD_VOICE_LANE,
  LEAD_VOICE_MIN_INBOUND,
  LEAD_VOICE_MOTIVOS,
  LEAD_VOICE_MOTIVO_STATUS,
  LEAD_VOICE_OUTCOMES,
  LEAD_VOICE_RESULTS,
  LEAD_VOICE_RETRY_GAP_HOURS,
  LEAD_VOICE_VARS,
  buildLeadFicha,
  leadVoiceInitiation,
  leadVoiceSettingsFrom,
  translateLeadResult,
} from "@/lib/voice-leads";
import { LEAD_IN_PROGRESS_TTL_MINUTES } from "@/lib/voice-recovery";
import { VOICE_SUNDAY_START_HOUR } from "@/lib/voice-recovery-queue";

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

const MOM = read("docs/mom/master-pedidos-v1.md");
const DOC = read("docs/voz-leads-agente.md");
const MIGRATION = read("db/migrations/0247_voice_lead_calls.sql");

/** Desde un encabezado hasta el siguiente del mismo nivel (o el final). */
function section(text: string, heading: string, nextHeadingPrefix: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(nextHeadingPrefix, start + heading.length);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

const S33 = section(MOM, "## 33. Agente de voz para leads", "\n## ");
const sub = (n: number) => section(S33, `### 33.${n} `, "\n### ");

describe("MOM §33: la sección existe y dice su estado", () => {
  it("encabezado, estado y subsecciones", () => {
    expect(MOM).toContain("## 33. Agente de voz para leads (piloto Biru, 12-10-2026)");
    expect(S33).toContain("Estado: construido, apagado por tienda.");
    for (let n = 1; n <= 9; n++) expect(S33).toContain(`### 33.${n} `);
    // Es la última sección: nada de §33 queda colgando dentro de otra.
    expect(MOM.trimEnd().endsWith(S33.trimEnd())).toBe(true);
  });

  it("§11.8 remite a §33 donde los dos agentes se tocan", () => {
    const s118 = section(MOM, "### 11.8 Recuperación por agente de voz", "\n### 11.9 ");
    // La lista «no llamar» compartida, el tope y los tableros solo de pedidos,
    // el agente ElevenLabs que NO es el de leads y el pendiente.
    expect(s118).toContain("incluye\n   a quien se lo pidió al agente de leads (§33.7).");
    expect(s118).toContain("cuentan solo `voice_calls.purpose = 'order'`");
    expect(s118).toContain("**No es el agente de leads (12-10-2026).**");
    expect(s118).toContain("**Leads por voz** (12-10-2026)");
  });
});

describe("MOM §33.2: quién entra a la cola", () => {
  const s = sub(2);

  it("nombra cada código de exclusión, en el orden en que los evalúa `leadVoiceEligible`", () => {
    // El orden importa: la primera condición que falla es la razón que ve la
    // asesora en el drawer. Un MOM con otro orden explicaría otra razón.
    let last = -1;
    for (const code of LEAD_VOICE_EXCLUSIONS) {
      const at = s.indexOf(`\`${code}\``);
      expect(at, code).toBeGreaterThan(last);
      last = at;
    }
  });

  it("las constantes que cita son las del código", () => {
    expect(LEAD_VOICE_MIN_INBOUND).toBe(2);
    expect(s).toContain("Escribió dos veces o más");
    expect(s).toContain(`pasaron ${LEAD_VOICE_RETRY_GAP_HOURS} horas desde el intento anterior`);
    expect(s).toContain("**La cola falla cerrada**");
  });
});

describe("MOM §33.3: el grupo de control", () => {
  it("es el experimento del código, aparte del de cobertura", () => {
    expect(LEAD_VOICE_EXPERIMENT).toBe("agente_voz_leads_v1");
    const s = sub(3);
    expect(s).toContain(`\`${LEAD_VOICE_EXPERIMENT}\``);
    expect(s).toContain("`frio_cobertura_v1`");
    expect(s).toContain("**sea cual sea su brazo**");
    expect(s).toContain("**El control nunca se llama, ni a mano.**");
    expect(s).toContain("**Intención de tratar.**");
  });
});

describe("MOM §33.4: los ajustes dicen los defectos y rangos de la base y del código", () => {
  const s = sub(4);
  const defaults = leadVoiceSettingsFrom(null);
  const fields = {
    voice_lead_daily_cap: defaults.dailyCap,
    voice_lead_max_attempts: defaults.maxAttempts,
    voice_lead_wait_minutes: defaults.waitMinutes,
    voice_lead_max_age_hours: defaults.maxAgeHours,
    voice_lead_holdout_pct: defaults.holdoutPct,
    voice_lead_hour_start: defaults.hourStart,
    voice_lead_hour_end: defaults.hourEnd,
  } as const;

  for (const [col, def] of Object.entries(fields) as [keyof typeof fields, number][]) {
    it(`${col}: migración, código, formulario y MOM coinciden`, () => {
      const m = new RegExp(
        `add column if not exists ${col} integer not null default (\\d+)\\s+check \\(${col} between (\\d+) and (\\d+)\\)`,
      ).exec(MIGRATION);
      expect(m, col).not.toBeNull();
      const [, dbDefault, dbMin, dbMax] = m!.map(Number);
      expect(def).toBe(dbDefault);
      expect(VOICE_LEAD_LIMITS[col]).toEqual({ min: dbMin, max: dbMax });
    });
  }

  it("la tabla del MOM tiene cada fila con su defecto y su rango", () => {
    const row = (col: keyof typeof fields) => `| ${fields[col]} | ${VOICE_LEAD_LIMITS[col].min}–${VOICE_LEAD_LIMITS[col].max} |`;
    for (const col of Object.keys(fields) as (keyof typeof fields)[]) {
      if (col === "voice_lead_hour_start" || col === "voice_lead_hour_end") continue;
      expect(s).toContain(`| \`${col}\` ${row(col)}`);
    }
    const h = VOICE_LEAD_LIMITS;
    expect(s).toContain(
      `| \`voice_lead_hour_start\` / \`voice_lead_hour_end\` | ${defaults.hourStart} / ${defaults.hourEnd} | ` +
        `${h.voice_lead_hour_start.min}–${h.voice_lead_hour_start.max} / ${h.voice_lead_hour_end.min}–${h.voice_lead_hour_end.max} |`,
    );
    expect(s).toContain(`Los domingos empieza a las ${VOICE_SUNDAY_START_HOUR}:00`);
    expect(defaults.enabled).toBe(false);
    expect(defaults.auto).toBe(false);
    expect(defaults.campaignIds).toEqual([]);
  });

  it("el barrido corre dos minutos después del de Reproprovincia", () => {
    const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    const leads = vercel.crons.find((c) => c.path === "/api/cron/voice-leads");
    const repro = vercel.crons.find((c) => c.path === "/api/cron/voice-recovery");
    expect(repro?.schedule).toBe("*/5 * * * *");
    const minutes = leads!.schedule.split(" ")[0]!.split(",").map(Number);
    expect(minutes).toEqual(Array.from({ length: 12 }, (_, i) => 2 + 5 * i));
    expect(s).toContain("en los minutos 2, 7, 12… 57 (dos\n  después del de Reproprovincia)");
  });
});

describe("MOM §33.6: lo que escribe cada resultado", () => {
  const s = sub(6);

  it("tiene una fila por cada resultado que el agente puede registrar", () => {
    for (const r of LEAD_VOICE_RESULTS) expect(s, r).toContain(`| \`${r}\` |`);
  });

  it("cada motivo lleva al estado que de verdad escribe `LEAD_VOICE_MOTIVO_STATUS`", () => {
    const row = s.split("\n").find((l) => l.startsWith("| `no_compra` |"))!;
    expect(row).toBeDefined();
    for (const motivo of LEAD_VOICE_MOTIVOS) {
      const at = row.indexOf(`\`${motivo}\``);
      expect(at, motivo).toBeGreaterThan(0);
      // Del motivo al «;» que cierra su tramo («`a`, `b` y `c` → `estado`;»).
      const tramo = row.slice(at, row.indexOf(";", at) < 0 ? undefined : row.indexOf(";", at));
      expect(tramo, motivo).toContain(`→ \`${LEAD_VOICE_MOTIVO_STATUS[motivo]}\``);
    }
  });

  it("las reglas que protegen a la persona y a la asesora están escritas", () => {
    expect(s).toContain("`kind = 'voice_agent'`");
    expect(s).toContain("**No contactar va siempre.**");
    expect(s).toContain("**La captura vive en la llamada**");
    expect(s).toContain("**Guardas para no pisar a una asesora.**");
    expect(s).toContain("**Modo prueba**");
  });
});

describe("MOM §33.7: separado de Reproprovincia", () => {
  it("dice el carril, la ventana del vigilante y la lista compartida", () => {
    const s = sub(7);
    expect(LEAD_VOICE_LANE).toBe("leads");
    expect(s).toContain(`\`agent_number = '${LEAD_VOICE_LANE}'\``);
    expect(LEAD_IN_PROGRESS_TTL_MINUTES).toBe(8);
    expect(s).toContain(`**${LEAD_IN_PROGRESS_TTL_MINUTES} minutos**`);
    expect(s).toContain("**La lista «no llamar» es una por tienda para los dos agentes, a\n  propósito.**");
  });
});

describe("MOM §33.9: el adelanto se cita, no se copia", () => {
  it("nombra la constante del adelanto en vez de escribir el número de Kapta", () => {
    const s = sub(9);
    expect(s).toContain("`ADELANTO_MINIMO` (`lib/adelanto-minimo.ts`)");
    expect(sub(5)).toContain("`ADELANTO_MINIMO`");
  });
});

describe("la migración 0247 valida los resultados por carril", () => {
  it("un lead solo puede tener los resultados del carril de leads", () => {
    const lead = /\(purpose = 'lead' and outcome in \(([\s\S]*?)\)\)/.exec(MIGRATION);
    expect(lead).not.toBeNull();
    const values = [...lead![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(values)).toEqual(new Set(LEAD_VOICE_OUTCOMES));
    // Nunca `confirma`: es la marca que dispara la salida Swayp.
    expect(values).not.toContain("confirma");
  });

  it("los de pedido no cambian (§11.8)", () => {
    expect(MIGRATION).toContain(
      "(purpose = 'order' and outcome in ('confirma', 'programar', 'no_contesta', 'cancela', 'sin_resultado'))",
    );
    expect(MIGRATION).toContain("(purpose = 'order' and order_id is not null and lead_id is null)");
    expect(MIGRATION).toContain("(purpose = 'lead' and lead_id is not null and order_id is null)");
  });

  it("y la prueba de base lo comprueba en verify-db", () => {
    const smoke = read("scripts/sql/voice_lead_smoke.sql");
    expect(smoke.trimStart().split("\n").find((l) => !l.startsWith("--"))).toBe("begin;");
    expect(smoke.trimEnd().endsWith("rollback;")).toBe(true);
    expect(read("scripts/verify-db.sh")).toContain('$PSQL -f "$ROOT/scripts/sql/voice_lead_smoke.sql"');
    expect(read("DEPLOY.md")).toContain("**Migración `0247_voice_lead_calls.sql`**, a mano y ANTES del código");
  });
});

describe("docs/voz-leads-agente.md: el guion que se pega en ElevenLabs", () => {
  const prompt = /## 3\. Prompt[\s\S]*?```text\n([\s\S]*?)```/.exec(DOC)?.[1] ?? "";

  it("documenta cada variable que Kapta manda, y el prompt no usa ninguna otra", () => {
    expect(LEAD_VOICE_VARS).toHaveLength(15);
    expect(DOC).toContain("**siempre las 15 variables, todas como\ntexto**");
    for (const v of LEAD_VOICE_VARS) expect(DOC, v).toContain(`{{${v}}}`);
    expect(prompt.length).toBeGreaterThan(1000);
    // Una variable que Kapta no manda deja la conversación sin arrancar. Las
    // de sistema (`system__…`) las pone ElevenLabs.
    const used = new Set([...prompt.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]!));
    for (const v of used) {
      expect(v.startsWith("system__") || (LEAD_VOICE_VARS as readonly string[]).includes(v), v).toBe(true);
    }
  });

  it("el prompt nombra cada resultado y cada motivo que acepta el registro", () => {
    for (const r of LEAD_VOICE_RESULTS) expect(prompt, r).toContain(`"${r}"`);
    for (const m of LEAD_VOICE_MOTIVOS) expect(prompt, m).toContain(`"${m}"`);
  });

  it("el primer mensaje documentado es el que arma Kapta", () => {
    const now = new Date("2026-10-12T20:00:00Z"); // 15:00 en Lima
    const ficha = (name: string | null) =>
      buildLeadFicha({
        lead: { name },
        storeName: "Kenku Peru",
        settings: { product: "", offer: "" },
        chat: "",
        now,
        attempt: 1,
        kind: "primera",
        mode: "test",
      });
    const first = (id: string | null, name: string | null) =>
      leadVoiceInitiation(id, id ? ficha(name) : null).conversation_config_override.agent.first_message;
    expect(first("vc-1", "Ana")).toBe("Hola, buenas tardes. ¿Hablo con Ana?");
    expect(first("vc-1", "🌸")).toBe("Hola, buenas tardes. ¿Con quién tengo el gusto?");
    expect(first(null, null)).toBe("Hola, buenas.");
    expect(DOC).toContain("«Hola, {saludo}. ¿Hablo con {nombre}?»");
    expect(DOC).toContain("«Hola, {saludo}. ¿Con quién tengo el gusto?»");
    expect(DOC).toContain("sin ficha (`encontrada = no`): «Hola, buenas.»");
    // Y todas las variables van, también sin ficha.
    expect(Object.keys(leadVoiceInitiation(null, null).dynamic_variables).sort()).toEqual([...LEAD_VOICE_VARS].sort());
  });
});

type Tool = {
  type: string;
  name: string;
  api_schema: {
    url: string;
    method: string;
    request_headers: Record<string, unknown>;
    request_body_schema: {
      required: string[];
      properties: Record<string, { type: string; enum?: string[]; dynamic_variable?: string }>;
    };
  };
};

describe("docs/voz-leads-agente.md: las dos tools apuntan a lo que las rutas leen", () => {
  const tools: Tool[] = [...DOC.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((m) => m[1]!)
    .filter((block) => block.includes('"type": "webhook"'))
    .map((block) => JSON.parse(block) as Tool);
  const tool = (name: string) => {
    const t = tools.find((x) => x.name === name);
    expect(t, name).toBeDefined();
    return t!;
  };

  it("son exactamente dos, POST, con el secreto en `x-voice-secret`", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(["consultar_cobertura", "registrar_resultado_lead"]);
    for (const t of tools) {
      expect(t.api_schema.method).toBe("POST");
      expect(Object.keys(t.api_schema.request_headers)).toEqual(["x-voice-secret"]);
      // La llamada la pone ElevenLabs desde la variable que Kapta le dio, no el modelo.
      expect(t.api_schema.request_body_schema.properties.voice_call_id?.dynamic_variable).toBe("voice_call_id");
    }
  });

  it("cada URL es una ruta que existe y cada propiedad es un campo que la ruta lee", () => {
    const routeOf = (t: Tool) => {
      const path = new URL(t.api_schema.url).pathname;
      return read(`app${path}/route.ts`);
    };

    const cobertura = tool("consultar_cobertura");
    expect(new URL(cobertura.api_schema.url).pathname).toBe("/api/voice/leads/cobertura");
    const src = routeOf(cobertura);
    for (const p of Object.keys(cobertura.api_schema.request_body_schema.properties)) {
      expect(src, p).toContain(`body.${p}`);
    }

    const registrar = tool("registrar_resultado_lead");
    expect(new URL(registrar.api_schema.url).pathname).toBe("/api/voice/leads/registrar");
    const reg = routeOf(registrar);
    expect(reg).toContain("bindLeadCall(admin, body.voice_call_id");
    expect(reg).toContain("conversation_id: body.conversation_id ?? null");
    expect(reg).toContain("translateLeadResult(body, now)");
    expect(registrar.api_schema.request_body_schema.properties.conversation_id?.dynamic_variable).toBe(
      "system__conversation_id",
    );
  });

  it("los `enum` son los del código, en el mismo orden", () => {
    const props = tool("registrar_resultado_lead").api_schema.request_body_schema.properties;
    expect(props.resultado?.enum).toEqual([...LEAD_VOICE_RESULTS]);
    expect(props.motivo?.enum).toEqual([...LEAD_VOICE_MOTIVOS]);
    expect(tool("registrar_resultado_lead").api_schema.request_body_schema.required).toEqual(["resultado", "resumen"]);
  });

  it("los datos que pide son los que `translateLeadResult` guarda en la captura", () => {
    const props = Object.keys(tool("registrar_resultado_lead").api_schema.request_body_schema.properties);
    const control = new Set(["voice_call_id", "conversation_id", "resultado", "motivo", "fecha", "hora", "resumen"]);
    const datos = props.filter((p) => !control.has(p));
    const input: Record<string, string> = { resultado: "atender_ahora", resumen: "Quiere el 3x2." };
    for (const p of datos) input[p] = p === "cantidad" ? "3" : `valor ${p}`;
    const action = translateLeadResult(input);
    expect(action.kind).toBe("apply");
    const captura = (action as Extract<typeof action, { kind: "apply" }>).captura!;
    expect(new Set(Object.keys(captura))).toEqual(new Set(datos));
    for (const p of datos) expect(captura[p as keyof typeof captura], p).toBe(p === "cantidad" ? 3 : `valor ${p}`);
  });

  it("fecha AAAA-MM-DD y hora HH:MM de Lima, como dice la descripción", () => {
    const props = tool("registrar_resultado_lead").api_schema.request_body_schema.properties as Record<
      string,
      { description?: string }
    >;
    expect(props.fecha?.description).toContain("AAAA-MM-DD");
    expect(props.hora?.description).toContain("HH:MM de 24 horas");
    const now = new Date("2026-10-12T15:00:00Z");
    const action = translateLeadResult(
      { resultado: "volver_a_llamar", fecha: "2026-10-14", hora: "16:30", resumen: "Pidió el miércoles." },
      now,
    );
    expect(action.kind === "apply" && action.followup).toEqual({ at: "2026-10-14T21:30:00.000Z" });
  });
});

describe("docs/voz-leads-agente.md: webhooks, ajustes y variables de Vercel", () => {
  it("las rutas de los webhooks existen", () => {
    expect(DOC).toContain("/api/voice/leads/inicio");
    expect(DOC).toContain("/api/voice/elevenlabs/post-call");
    expect(() => read("app/api/voice/leads/inicio/route.ts")).not.toThrow();
    expect(() => read("app/api/voice/elevenlabs/post-call/route.ts")).not.toThrow();
  });

  it("cada variable de Vercel que nombra es la que lee `lib/env.ts`", () => {
    const envSrc = read("lib/env.ts");
    for (const name of ["TELNYX_LEADS_SIP_URI", "TELNYX_LEADS_FROM_NUMBER", "VOICE_LEADS_TOOLS_SECRET", "ELEVENLABS_WEBHOOK_SECRET"]) {
      expect(DOC, name).toContain(`\`${name}\``);
      expect(envSrc, name).toContain(`process.env.${name}`);
    }
    expect(DOC).toContain("**Nunca en un chat**");
  });

  it("la duración máxima del agente cabe en la ventana del vigilante", () => {
    expect(DOC).toContain("`max_duration` = **300 s**");
    // Si el agente pudiera hablar más que la ventana, el vigilante cerraría
    // como «no contestó» una conversación viva.
    expect(LEAD_IN_PROGRESS_TTL_MINUTES * 60).toBeGreaterThan(300);
  });

  it("los pasos de encendido nombran la campaña de Biru", () => {
    expect(DOC).toContain("campaña de Biru: `120248136956710056`");
  });
});
