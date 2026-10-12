// Ajustes del agente de voz para leads, piloto Biru (MOM §33, 0247).
//
// Un ajuste de tienda pasa por cuatro sitios que nadie obliga a estar de
// acuerdo: el formulario, la acción que lee el FormData campo por campo, el
// armado del patch y la página que pinta lo guardado. Si uno se olvida, el
// valor se pierde EN SILENCIO (test/store-settings-wiring.test.ts cuenta las
// dos veces que pasó). Aquí se atan los doce `voice_lead_*` entre sí y con los
// CHECK de la migración, y se prueba lo único raro: las casillas de campañas,
// que viajan como varios valores con el mismo nombre.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  updates: [] as Record<string, unknown>[],
}));

// La acción de guardado arrastra módulos solo-servidor (agent-names, …).
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("login");
  },
}));
vi.mock("@/lib/db", () => {
  const from = (table: string) => {
    let update: Record<string, unknown> | null = null;
    const q: any = {};
    for (const m of ["select", "eq", "in", "is", "not", "order", "limit"]) q[m] = () => q;
    q.update = (v: Record<string, unknown>) => {
      update = v;
      return q;
    };
    const result = () => {
      if (update) {
        state.updates.push(update);
        return { data: null, error: null };
      }
      if (table === "stores") return { data: { id: "store", org_id: "org", shalom_pro_email: null }, error: null };
      if (table === "memberships") return { data: { role: "owner" }, error: null };
      return { data: null, error: null };
    };
    q.maybeSingle = q.single = async () => result();
    q.then = (res: any, rej: any) => Promise.resolve(result()).then(res, rej);
    return q;
  };
  return {
    createAdminSupabase: () => ({ from }),
    createServerSupabase: async () => ({ from, auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) } }),
  };
});

import {
  LEAD_VOICE_CAMPAIGN_TOP,
  VOICE_LEAD_LIMITS,
  VOICE_LEAD_OFFER_MAX,
  VOICE_LEAD_PRODUCT_MAX,
  buildStoreUpdate,
  leadVoiceCampaignOptions,
  leadVoiceOwnNumber,
  loadLeadVoiceCampaigns,
  voiceLeadCampaignIds,
  type VoiceLeadLimitField,
} from "@/lib/store-settings";
import { updateStore } from "@/app/dashboard/[storeId]/settings/actions";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const FORM = read("components/store-settings.tsx");
const ACTION = read("app/dashboard/[storeId]/settings/actions.ts");
const PAGE = read("app/dashboard/[storeId]/settings/page.tsx");
const MIGRATION = read("db/migrations/0247_voice_lead_calls.sql");

const CAMPOS = [
  "voice_lead_enabled",
  "voice_lead_auto",
  "voice_lead_daily_cap",
  "voice_lead_max_attempts",
  "voice_lead_wait_minutes",
  "voice_lead_max_age_hours",
  "voice_lead_holdout_pct",
  "voice_lead_hour_start",
  "voice_lead_hour_end",
  "voice_lead_campaign_ids",
  "voice_lead_product",
  "voice_lead_offer",
] as const;

// ── El formulario, la acción y la página ────────────────────────────────────

describe("el formulario, la acción y la página conocen los doce campos", () => {
  for (const campo of CAMPOS) {
    it(campo, () => {
      // `HourRange` recibe `startName=`/`endName=`: cuenta igual.
      expect(FORM).toMatch(new RegExp(`[nN]ame="${campo}"`));
      // Las casillas viajan como varios valores: `get` se quedaría con uno.
      expect(ACTION).toContain(campo === "voice_lead_campaign_ids" ? `getAll("${campo}")` : `get("${campo}")`);
      expect(PAGE).toContain(`${campo}:`);
      // Y buildStoreUpdate tiene rama para él (si no, se perdería en silencio).
      const valor = campo === "voice_lead_enabled" || campo === "voice_lead_auto" ? "true" : "1";
      expect(Object.keys(buildStoreUpdate({ [campo]: valor }))).toContain(campo);
    });
  }

  it("las casillas llevan un oculto vacío para poder desmarcar la última", () => {
    expect(FORM).toContain('<input type="hidden" name="voice_lead_campaign_ids" value="" />');
    expect(ACTION).toContain("formData.getAll(k)");
  });

  it("los números del formulario usan los mismos límites que el servidor", () => {
    for (const k of Object.keys(VOICE_LEAD_LIMITS) as VoiceLeadLimitField[]) {
      if (k === "voice_lead_hour_start" || k === "voice_lead_hour_end") continue; // HourRange: 0..23 y 1..24 fijos
      expect(FORM).toContain(`{...VOICE_LEAD_LIMITS.${k}}`);
    }
    expect(FORM).toContain("maxLength={VOICE_LEAD_PRODUCT_MAX}");
    expect(FORM).toContain("maxLength={VOICE_LEAD_OFFER_MAX}");
  });
});

// ── Los rangos son los CHECK de 0247 ────────────────────────────────────────

describe("los rangos de buildStoreUpdate", () => {
  it("son exactamente los CHECK de la migración (uno más ancho tumbaría el guardado)", () => {
    const checks = Object.fromEntries(
      [...MIGRATION.matchAll(/check \((voice_lead_\w+) between (\d+) and (\d+)\)/g)].map((m) => [
        m[1],
        { min: Number(m[2]), max: Number(m[3]) },
      ]),
    );
    expect(checks).toEqual(VOICE_LEAD_LIMITS);
  });

  for (const [campo, { min, max }] of Object.entries(VOICE_LEAD_LIMITS)) {
    it(`${campo}: ${min}..${max}, y fuera de rango conserva el actual`, () => {
      expect(buildStoreUpdate({ [campo]: String(min) })).toEqual({ [campo]: min });
      expect(buildStoreUpdate({ [campo]: ` ${max} ` })).toEqual({ [campo]: max });
      expect(buildStoreUpdate({ [campo]: String(min - 1) })).toEqual({});
      expect(buildStoreUpdate({ [campo]: String(max + 1) })).toEqual({});
      expect(buildStoreUpdate({ [campo]: "mucho" })).toEqual({});
      expect(buildStoreUpdate({ [campo]: "" })).toEqual({});
    });
  }
});

// ── Toggles, campañas y textos ──────────────────────────────────────────────

describe("buildStoreUpdate del agente de leads", () => {
  it("los dos interruptores se encienden y se APAGAN", () => {
    expect(buildStoreUpdate({ voice_lead_enabled: "true", voice_lead_auto: "true" })).toEqual({
      voice_lead_enabled: true,
      voice_lead_auto: true,
    });
    expect(buildStoreUpdate({ voice_lead_enabled: "false", voice_lead_auto: "false" })).toEqual({
      voice_lead_enabled: false,
      voice_lead_auto: false,
    });
  });

  it("una tarjeta que no trae los campos no toca nada del agente de leads", () => {
    const patch = buildStoreUpdate({ name: "Kenku", voice_recovery_enabled: "true" });
    expect(Object.keys(patch).filter((k) => k.startsWith("voice_lead_"))).toEqual([]);
  });

  it("campañas: varias casillas o comas, sin vacíos ni repetidas", () => {
    expect(buildStoreUpdate({ voice_lead_campaign_ids: ["", "120248136956710056", " 777 ", "120248136956710056"] })).toEqual({
      voice_lead_campaign_ids: ["120248136956710056", "777"],
    });
    expect(buildStoreUpdate({ voice_lead_campaign_ids: "120248136956710056, 777,,777" })).toEqual({
      voice_lead_campaign_ids: ["120248136956710056", "777"],
    });
    expect(voiceLeadCampaignIds(["1,2", "2", " "])).toEqual(["1", "2"]);
  });

  it("campañas: desmarcar todas guarda la lista vacía (el agente no llama a nadie)", () => {
    expect(buildStoreUpdate({ voice_lead_campaign_ids: [""] })).toEqual({ voice_lead_campaign_ids: [] });
    expect(buildStoreUpdate({ voice_lead_campaign_ids: "" })).toEqual({ voice_lead_campaign_ids: [] });
  });

  it("producto y oferta: recortados, vaciables, y si pasan el tope no se guardan", () => {
    expect(buildStoreUpdate({ voice_lead_product: "  Shampoo Birú anticaspa ", voice_lead_offer: " 1 unidad S/ 85 " })).toEqual({
      voice_lead_product: "Shampoo Birú anticaspa",
      voice_lead_offer: "1 unidad S/ 85",
    });
    expect(buildStoreUpdate({ voice_lead_product: "  ", voice_lead_offer: "" })).toEqual({
      voice_lead_product: null,
      voice_lead_offer: null,
    });
    expect(buildStoreUpdate({ voice_lead_product: "x".repeat(VOICE_LEAD_PRODUCT_MAX) })).toEqual({
      voice_lead_product: "x".repeat(VOICE_LEAD_PRODUCT_MAX),
    });
    expect(buildStoreUpdate({ voice_lead_offer: "x".repeat(VOICE_LEAD_OFFER_MAX) })).toEqual({
      voice_lead_offer: "x".repeat(VOICE_LEAD_OFFER_MAX),
    });
    // Recortarla podría dejar un precio a medias, y el agente la dice tal cual.
    expect(buildStoreUpdate({ voice_lead_product: "x".repeat(VOICE_LEAD_PRODUCT_MAX + 1) })).toEqual({});
    expect(buildStoreUpdate({ voice_lead_offer: "x".repeat(VOICE_LEAD_OFFER_MAX + 1) })).toEqual({});
  });
});

// ── La acción de guardado, con el FormData de verdad ────────────────────────

describe("updateStore con las casillas de campañas", () => {
  beforeEach(() => {
    state.updates = [];
  });

  const form = (entries: [string, string][]) => {
    const fd = new FormData();
    fd.append("store_id", "store");
    for (const [k, v] of entries) fd.append(k, v);
    return fd;
  };

  it("guarda todas las marcadas, no solo la primera", async () => {
    const r = await updateStore({}, form([
      ["voice_lead_campaign_ids", ""],
      ["voice_lead_campaign_ids", "120248136956710056"],
      ["voice_lead_campaign_ids", "777"],
    ]));
    expect(r).toEqual({ notice: "Tienda actualizada." });
    expect(state.updates).toEqual([{ voice_lead_campaign_ids: ["120248136956710056", "777"] }]);
  });

  it("solo el oculto (ninguna marcada) ⇒ lista vacía", async () => {
    await updateStore({}, form([["voice_lead_campaign_ids", ""]]));
    expect(state.updates).toEqual([{ voice_lead_campaign_ids: [] }]);
  });

  it("otra tarjeta, sin el campo ⇒ las campañas no se tocan", async () => {
    await updateStore({}, form([["voice_lead_daily_cap", "60"]]));
    expect(state.updates).toEqual([{ voice_lead_daily_cap: 60 }]);
  });
});

// ── La lista de campañas para elegir ────────────────────────────────────────

describe("leadVoiceCampaignOptions", () => {
  const ad = (ad_id: string, campaign_id: string | null, campaign_name: string | null = `Campaña ${campaign_id}`) => ({
    ad_id,
    campaign_id,
    campaign_name,
  });

  it("cuenta leads por campaña a través de sus anuncios, de más a menos", () => {
    const options = leadVoiceCampaignOptions(
      ["a1", "a1", "a2", "b1", "x9"],
      [ad("a1", "A", "CBO Biru | Kapso | 1407"), ad("a2", "A", null), ad("b1", "B"), ad("c1", null)],
      [],
    );
    // x9 no está en meta_ads y c1 no tiene campaña: no se cuentan.
    expect(options).toEqual([
      { id: "A", name: "CBO Biru | Kapso | 1407", leads: 3 },
      { id: "B", name: "Campaña B", leads: 1 },
    ]);
  });

  it(`solo las ${LEAD_VOICE_CAMPAIGN_TOP} con más leads, más las elegidas aunque no tengan`, () => {
    const ads = Array.from({ length: 25 }, (_, i) => ad(`ad${i}`, `C${i}`));
    // C0 tiene 25 leads, C24 tiene 1.
    const leads = ads.flatMap((a, i) => Array.from({ length: 25 - i }, () => a.ad_id));
    const options = leadVoiceCampaignOptions(leads, [...ads, ad("z1", "ELEGIDA", "Apagada")], ["C24", "ELEGIDA", "SIN_NOMBRE", "C0"]);
    expect(options.slice(0, LEAD_VOICE_CAMPAIGN_TOP).map((o) => o.id)).toEqual(
      Array.from({ length: LEAD_VOICE_CAMPAIGN_TOP }, (_, i) => `C${i}`),
    );
    // Las elegidas que no entraron arriba van después, con lo que se sepa.
    expect(options.slice(LEAD_VOICE_CAMPAIGN_TOP)).toEqual([
      { id: "C24", name: "Campaña C24", leads: 1 },
      { id: "ELEGIDA", name: "Apagada", leads: 0 },
      { id: "SIN_NOMBRE", name: null, leads: 0 },
    ]);
  });
});

// ── La lectura de campañas ──────────────────────────────────────────────────

type Call = { table: string; ops: unknown[][]; range?: [number, number] };

function fakeAdmin(reply: (c: Call) => { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const q: any = {};
      for (const m of ["select", "eq", "not", "gte", "order", "in", "limit"]) {
        q[m] = (...args: unknown[]) => {
          call.ops.push([m, ...args]);
          return q;
        };
      }
      q.range = (a: number, b: number) => {
        call.range = [a, b];
        return q;
      };
      q.then = (res: any, rej: any) => Promise.resolve().then(() => reply(call)).then(res, rej);
      return q;
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

describe("loadLeadVoiceCampaigns", () => {
  const NOW = new Date("2026-10-12T15:00:00Z");

  it("lee los leads de la tienda de 30 días por páginas y resuelve sus anuncios por lotes", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `l${i}`, ad_id: `ad${i % 300}` }));
    const page2 = [{ id: "z", ad_id: "ad0" }];
    const { admin, calls } = fakeAdmin((c) => {
      if (c.table === "leads") return { data: c.range?.[0] === 0 ? page1 : page2, error: null };
      const ids = (c.ops.find((o) => o[0] === "in")?.[2] ?? []) as string[];
      return { data: ids.map((id) => ({ ad_id: id, campaign_id: id === "ad0" ? "BIRU" : "OTRA", campaign_name: null })), error: null };
    });
    const options = await loadLeadVoiceCampaigns(admin, "store", [], NOW);

    const leadCalls = calls.filter((c) => c.table === "leads");
    expect(leadCalls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999]]);
    expect(leadCalls[0]!.ops).toEqual(
      expect.arrayContaining([
        ["eq", "store_id", "store"],
        ["not", "ad_id", "is", null],
        ["gte", "first_seen_at", "2026-09-12T15:00:00.000Z"],
      ]),
    );
    // 300 anuncios distintos ⇒ dos lotes de meta_ads, ninguno de más de 200.
    const adCalls = calls.filter((c) => c.table === "meta_ads");
    expect(adCalls).toHaveLength(2);
    for (const c of adCalls) expect((c.ops.find((o) => o[0] === "in")![2] as string[]).length).toBeLessThanOrEqual(200);

    // ad0 aparece 4 veces en la página 1 (0, 300, 600, 900) y 1 en la 2.
    expect(options).toEqual([
      { id: "OTRA", name: null, leads: 996 },
      { id: "BIRU", name: null, leads: 5 },
    ]);
  });

  it("si la lectura de leads falla, igual salen las elegidas (sin conteo) para no borrarlas al guardar", async () => {
    const { admin } = fakeAdmin((c) => {
      if (c.table === "leads") return { data: null, error: { message: "timeout" } };
      return { data: [{ ad_id: "x", campaign_id: "120248136956710056", campaign_name: "CBO Biru | Kapso | 1407" }], error: null };
    });
    const options = await loadLeadVoiceCampaigns(admin, "store", ["120248136956710056", "777"], NOW);
    expect(options).toEqual([
      { id: "120248136956710056", name: "CBO Biru | Kapso | 1407", leads: 0 },
      { id: "777", name: null, leads: 0 },
    ]);
  });

  it("si ni el nombre se puede leer, la elegida sale con su id", async () => {
    const { admin } = fakeAdmin(() => ({ data: null, error: { message: "caído" } }));
    expect(await loadLeadVoiceCampaigns(admin, "store", ["777"], NOW)).toEqual([{ id: "777", name: null, leads: 0 }]);
  });
});

// ── La página y la sección ──────────────────────────────────────────────────

describe("la página de Ajustes", () => {
  it("pasa solo sí/no del entorno, nunca el valor", () => {
    expect(PAGE).toContain("configured: leadVoiceConfigured(),");
    expect(PAGE).toContain(
      "ownNumber: leadVoiceOwnNumber(process.env.TELNYX_LEADS_FROM_NUMBER, process.env.TELNYX_FROM_NUMBER),",
    );
    // Nada del entorno se pinta tal cual: solo los dos booleanos de arriba.
    expect(PAGE).not.toMatch(/:\s*process\.env\.TELNYX_(LEADS_)?FROM_NUMBER\b/);
    expect(PAGE).not.toMatch(/:\s*env\.telnyxLeads(FromNumber|SipUri)\(\)/);
  });

  it("número propio: definido y distinto del de Reproprovincia (por dígitos)", () => {
    expect(leadVoiceOwnNumber("+51 1 700 1234", "+12025550100")).toBe(true);
    expect(leadVoiceOwnNumber(undefined, "+12025550100")).toBe(false);
    expect(leadVoiceOwnNumber("  ", "+12025550100")).toBe(false);
    // El mismo número escrito distinto no es propio: el lead vería el de siempre.
    expect(leadVoiceOwnNumber("+1 (202) 555-0100", "+12025550100")).toBe(false);
    expect(leadVoiceOwnNumber("+5117001234", undefined)).toBe(true);
  });

  it("los defectos son los de 0247, y el tablero no tumba Ajustes", () => {
    expect(PAGE).toContain("Pre-0247 las columnas no existen ⇒ agente de leads apagado");
    expect(PAGE).toContain("leadVoiceSettingsFrom(full)");
    expect(PAGE).toContain("loadLeadVoicePilotReport(admin, storeId, now).catch(() => null)");
    expect(PAGE).toContain("loadLeadVoiceCampaigns(admin, storeId, leadVoice.campaignIds, now)");
  });
});

describe("la sección del formulario", () => {
  const flat = FORM.replace(/\s+/g, " ");

  it("va en el índice y justo después del agente de Reproprovincia", () => {
    expect(FORM).toContain('{ id: "agente-voz-leads", label: "Agente de voz · Leads" }');
    expect(FORM).toContain('id="agente-voz-leads"');
    expect(FORM).toContain('title="Agente de voz · Leads (piloto)"');
    const repro = FORM.indexOf('id="agente-voz"');
    const leads = FORM.indexOf("<LeadVoiceSection data={data} />");
    const shalom = FORM.indexOf("<ShalomNoticesSection data={data} />");
    expect(repro).toBeGreaterThan(-1);
    expect(leads).toBeGreaterThan(repro);
    expect(shalom).toBeGreaterThan(leads);
  });

  it("la oferta trae el ejemplo de Biru, y el control nunca se llama", () => {
    expect(flat).toContain("«Shampoo Birú anticaspa: 1 unidad S/ 85; 3x2: 3 por S/ 170; 5x3: 5 por S/ 255»");
    expect(flat).toContain("El grupo de control nunca se llama");
    expect(flat).toContain("conversión del tratamiento menos la del control");
  });

  it("el tablero tiene las columnas del piloto", () => {
    for (const col of [
      "Llamados por el agente",
      "Contestaron",
      "Atender ahora",
      "Tocados por asesora",
      "Ventas",
      "Conversión",
    ]) {
      expect(FORM).toContain(`>${col}</th>`);
    }
    expect(flat).toContain("sin gestión · costo de línea");
    expect(flat).toContain("Por qué no compran:");
  });

  it("los domingos el agente llama desde las 11:00 (el texto viejo era falso)", () => {
    expect(flat).not.toContain("Los domingos el agente no llama");
    expect(flat).toContain("Los domingos empieza a las 11:00.");
  });
});
