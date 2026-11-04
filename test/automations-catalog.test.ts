// Panel «Automatizaciones» (MOM §40, 04-11-2026). Lo que se fija aquí: el
// catálogo es coherente consigo mismo; la lista blanca (lo ÚNICO que el panel
// puede escribir) sale del catálogo y no de otra lista a mano; cada columna
// que se escribe o se exige existe de verdad en las migraciones; y las reglas
// puras de las acciones (requisitos, tope, confirmación, historial).

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTOMATIONS,
  AUTOMATION_EFFECTS,
  AUTOMATION_GROUPS,
  AUTOMATION_WRITE_WHITELIST,
  ORG_AUTOMATION_TABLES,
  ORG_TABLE_SHAPE,
  RETRY_CAP_EVENT,
  STORE_AUTOMATION_COLUMNS,
  SWITCH_OFF,
  SWITCH_ON,
  automationEventLabel,
  automationValueLabel,
  confirmationText,
  detailPaths,
  isSwitchable,
  isUuid,
  isWhitelisted,
  joinNames,
  needsConfirmation,
  orgSwitchPatch,
  parseRetryDailyCap,
  retryVariantEventKey,
  switchRefusal,
  switchableEntry,
} from "@/lib/automations-catalog";
import { PERMISSIONS, PERMISSION_LABEL, GRANTED_ONE_BY_ONE, permissionsFor } from "@/lib/permissions";
import { navItems } from "@/components/sidebar";

const MIGRATIONS = (() => {
  const dir = join(__dirname, "..", "db", "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
})();

describe("el catálogo", () => {
  it("cada clave es única y cada entrada está en un grupo que existe", () => {
    const keys = AUTOMATIONS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    const groups = new Set<string>(AUTOMATION_GROUPS.map((g) => g.key));
    for (const entry of AUTOMATIONS) expect(groups.has(entry.group), entry.key).toBe(true);
    for (const group of AUTOMATION_GROUPS) expect(AUTOMATIONS.some((e) => e.group === group.key), group.key).toBe(true);
  });

  it("nombres únicos, explicación corta y efecto de la lista", () => {
    const names = AUTOMATIONS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of AUTOMATIONS) {
      expect(entry.what, entry.key).toMatch(/\.$/);
      expect(entry.what.length, entry.key).toBeLessThanOrEqual(260);
      expect(AUTOMATION_EFFECTS, entry.key).toContain(entry.effect);
    }
  });

  it("nunca enseña nombres de tablas ni columnas", () => {
    const technical = [
      ...ORG_AUTOMATION_TABLES,
      ...STORE_AUTOMATION_COLUMNS,
      "aliclik_enabled",
      "invoice_issuers",
      "auto_order_cohorts",
      "lead_routing_settings",
      "bot_order_secrets",
      "_enabled",
      "_auto",
    ];
    for (const entry of AUTOMATIONS) {
      const visible = [entry.name, entry.what, entry.requiresReason ?? "", entry.control.kind === "readonly" ? entry.control.how : "", entry.link?.label ?? ""].join(" ");
      for (const word of technical) expect(visible, `${entry.key}: ${word}`).not.toContain(word);
    }
  });

  it("los interruptores van en su grupo y lo que no tiene interruptor va en «Sin interruptor»", () => {
    for (const entry of AUTOMATIONS) {
      expect(entry.group === "sin_interruptor", entry.key).toBe(entry.control.kind === "readonly");
      if (entry.control.kind === "org_table") expect(entry.scope, entry.key).toBe("org");
      if (entry.control.kind === "store_column") expect(entry.scope, entry.key).toBe("store");
    }
  });

  it("todo lo que el pedido del owner nombró está, con su tipo de control", () => {
    const control = (key: string) => {
      const c = AUTOMATIONS.find((e) => e.key === key)?.control;
      if (!c) return null;
      return c.kind === "readonly" ? "readonly" : c.kind === "org_table" ? `${c.table}.${c.column}` : `stores.${c.column}`;
    };
    expect(control("swayp_auto")).toBe("swayp_auto_settings.enabled");
    expect(control("swayp_auto_pilot")).toBe("swayp_auto_settings.pilot_enabled");
    expect(control("swayp_pc_auto")).toBe("swayp_pc_auto_settings.enabled");
    expect(control("chatby_auto")).toBe("chatby_auto_settings.enabled");
    expect(control("chatby_auto_guide")).toBe("chatby_auto_settings.guide_enabled");
    const storeColumns = AUTOMATIONS.flatMap((e) => (e.control.kind === "store_column" ? [e.control.column] : []));
    expect(storeColumns.sort()).toEqual(
      [
        "voice_recovery_auto",
        "voice_lead_auto",
        "return_recovery_auto",
        "drip_template_enabled",
        "cart_seq_enabled",
        "delivered_thanks_enabled",
        "restock_enabled",
        "browse_template_enabled",
        "winback_template_enabled",
        "shalom_transit_template_enabled",
        "shalom_arrival_template_enabled",
        "shalom_reminder_template_enabled",
        "shalom_pickup_key_autosend_enabled",
        "olva_transit_template_enabled",
        "olva_arrival_template_enabled",
        "olva_paid_arrival_template_enabled",
        "olva_reminder_template_enabled",
      ].sort(),
    );
    for (const key of [
      "aliclik_scheduled",
      "invoices",
      "auto_orders",
      "lead_routing",
      "telegram_reports",
      "woo_sale_returns",
      "tanders_payments",
      "urpi_programming",
      "kapso_bot_orders",
      "yape_statement",
    ]) {
      expect(control(key), key).toBe("readonly");
    }
  });

  it("los requisitos: agentes de voz, recuperar devueltos y el piloto", () => {
    const requires = Object.fromEntries(
      AUTOMATIONS.flatMap((e) => (e.control.kind !== "readonly" && e.control.requires ? [[e.key, e.control.requires]] : [])),
    );
    expect(requires).toEqual({
      swayp_auto_pilot: "enabled",
      voice_recovery_auto: "voice_recovery_enabled",
      voice_lead_auto: "voice_lead_enabled",
      return_recovery_auto: "return_recovery_enabled",
    });
    for (const entry of AUTOMATIONS) {
      if (entry.control.kind !== "readonly" && entry.control.requires) expect(entry.requiresReason, entry.key).toMatch(/\.$/);
    }
  });

  it("cada requisito es una columna conocida", () => {
    for (const entry of AUTOMATIONS) {
      if (entry.control.kind === "readonly" || !entry.control.requires) continue;
      if (entry.control.kind === "org_table") {
        // El de la misma fila, y que sea a su vez un interruptor del panel.
        expect(ORG_TABLE_SHAPE[entry.control.table].columns, entry.key).toContain(entry.control.requires);
        expect(isWhitelisted(entry.control.table, entry.control.requires), entry.key).toBe(true);
      } else {
        expect(STORE_AUTOMATION_COLUMNS, entry.key).toContain(entry.control.requires);
        expect(MIGRATIONS, entry.control.requires).toMatch(new RegExp(`\\b${entry.control.requires}\\b`));
      }
    }
  });

  it("cada columna que se escribe existe en las migraciones y en la forma de su tabla", () => {
    for (const w of AUTOMATION_WRITE_WHITELIST) {
      expect(MIGRATIONS, `${w.table}.${w.column}`).toMatch(new RegExp(`\\b${w.column}\\b`));
      if (w.table !== "stores") expect(ORG_TABLE_SHAPE[w.table].columns, w.key).toContain(w.column);
    }
    for (const table of ORG_AUTOMATION_TABLES) expect(MIGRATIONS, table).toMatch(new RegExp(`create table if not exists (public\\.)?${table}\\b`));
  });

  it("los enlaces a ajustes de tienda apuntan a secciones que existen", () => {
    const settings = readFileSync(join(__dirname, "..", "components", "store-settings.tsx"), "utf8");
    for (const entry of AUTOMATIONS) {
      if (entry.link?.kind !== "store_settings") continue;
      expect(settings, `${entry.key} → #${entry.link.section}`).toContain(`id: "${entry.link.section}"`);
    }
  });
});

describe("la lista blanca", () => {
  it("contiene solo los interruptores del catálogo, uno por entrada, sin pares repetidos", () => {
    const switchables = AUTOMATIONS.filter(isSwitchable);
    expect(AUTOMATION_WRITE_WHITELIST.map((w) => w.key).sort()).toEqual(switchables.map((e) => e.key).sort());
    const pairs = AUTOMATION_WRITE_WHITELIST.map((w) => `${w.table}.${w.column}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const w of AUTOMATION_WRITE_WHITELIST) expect(["stores", ...ORG_AUTOMATION_TABLES]).toContain(w.table);
  });

  it("no deja escribir lo que no es un interruptor del panel", () => {
    expect(isWhitelisted("stores", "aliclik_enabled")).toBe(false);
    expect(isWhitelisted("stores", "voice_recovery_enabled")).toBe(false);
    expect(isWhitelisted("stores", "telegram_bot_token")).toBe(false);
    expect(isWhitelisted("swayp_auto_settings", "daily_cap")).toBe(false);
    expect(isWhitelisted("invoice_issuers", "mode")).toBe(false);
    expect(isWhitelisted("stores", "voice_recovery_auto")).toBe(true);
  });

  it("una clave solo vale para su tipo de interruptor", () => {
    expect(switchableEntry("swayp_auto", "org_table")?.key).toBe("swayp_auto");
    expect(switchableEntry("swayp_auto", "store_column")).toBeNull();
    expect(switchableEntry("voice_recovery_auto", "store_column")?.key).toBe("voice_recovery_auto");
    expect(switchableEntry("voice_recovery_auto", "org_table")).toBeNull();
    expect(switchableEntry("aliclik_scheduled", "store_column")).toBeNull();
    expect(switchableEntry("invoices", "org_table")).toBeNull();
    expect(switchableEntry("no_existe", "org_table")).toBeNull();
    expect(switchableEntry({ key: "swayp_auto" }, "org_table")).toBeNull();
  });
});

describe("las reglas de las acciones", () => {
  const pilot = switchableEntry("swayp_auto_pilot", "org_table")!;
  const voice = switchableEntry("voice_recovery_auto", "store_column")!;
  const drip = switchableEntry("drip_template", "store_column")!;

  it("encender sin el requisito se rechaza con un motivo claro; apagar siempre se puede", () => {
    expect(switchRefusal(pilot, { on: true, rowExists: true, requiresOn: false })).toBe("Enciende antes «Aliclik a Swayp automático».");
    expect(switchRefusal(pilot, { on: true, rowExists: true, requiresOn: true })).toBeNull();
    expect(switchRefusal(pilot, { on: false, rowExists: true, requiresOn: false })).toBeNull();
    expect(switchRefusal(voice, { on: true, rowExists: true, requiresOn: false })).toMatch(/activa el agente/);
    expect(switchRefusal(drip, { on: true, rowExists: true, requiresOn: false })).toBeNull();
  });

  it("sin fila de configuración no se crea nada", () => {
    expect(switchRefusal(pilot, { on: false, rowExists: false, requiresOn: true })).toBe("Esta automatización no está configurada en tu organización.");
  });

  it("el parche guarda quién solo donde la tabla lo tiene, y encender Swayp desde Por confirmar quita el freno", () => {
    const now = "2026-11-04T15:00:00.000Z";
    expect(orgSwitchPatch("swayp_auto_settings", "enabled", true, "u1", now)).toEqual({ enabled: true, updated_at: now });
    expect(orgSwitchPatch("chatby_auto_settings", "guide_enabled", false, "u1", now)).toEqual({ guide_enabled: false, updated_at: now, updated_by: "u1" });
    expect(orgSwitchPatch("swayp_pc_auto_settings", "enabled", true, "u1", now)).toEqual({
      enabled: true,
      updated_at: now,
      updated_by: "u1",
      paused_reason: null,
      paused_at: null,
    });
    expect(orgSwitchPatch("swayp_pc_auto_settings", "enabled", false, null, now)).toMatchObject({ enabled: false, paused_at: now, paused_reason: null });
  });

  it("el tope del día: entero entre 1 y 50", () => {
    expect(parseRetryDailyCap(10)).toBe(10);
    expect(parseRetryDailyCap("12")).toBe(12);
    expect(parseRetryDailyCap(" 50 ")).toBe(50);
    for (const bad of [0, 51, 2.5, "", "abc", null, undefined, Number.NaN, "1e1x"]) expect(parseRetryDailyCap(bad), String(bad)).toBeNull();
  });

  it("ids: solo uuid", () => {
    expect(isUuid("3f2c1d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f")).toBe(true);
    expect(isUuid("x; drop table stores")).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it("encender lo que sale de Kapta pide confirmación; lo que solo informa, no", () => {
    for (const entry of AUTOMATIONS.filter(isSwitchable)) expect(needsConfirmation(entry), entry.key).toBe(true);
    expect(needsConfirmation({ effect: "Solo informa" })).toBe(false);
    expect(confirmationText(voice, "Aurela")).toBe("¿Encender «Agente de voz de Repro Provincia» en Aurela? El agente llamará a clientas sin que nadie lo dispare.");
    expect(confirmationText(pilot)).toMatch(/^¿Encender «Piloto sin entrega previa»\? Kapta creará guías/);
  });

  it("se revalida la página de detalle de lo que cambió", () => {
    expect(detailPaths(pilot)).toEqual(["/dashboard/envios/automatico"]);
    expect(detailPaths(voice, "s1")).toEqual(["/dashboard/s1/settings"]);
    expect(detailPaths(switchableEntry("chatby_auto", "org_table")!)).toEqual([]);
  });
});

describe("el historial del panel", () => {
  it("nombra lo que cambió y su valor en palabras", () => {
    expect(automationEventLabel("swayp_auto")).toBe("Aliclik a Swayp automático");
    expect(automationEventLabel(retryVariantEventKey("alexis_autoecom:no_contesta"))).toBe("Reintentos Aliclik · Alexis (Grupo GF) → AUTOECOM · no contesta");
    expect(automationEventLabel(RETRY_CAP_EVENT)).toBe("Reintentos Aliclik · tope del día");
    expect(automationValueLabel("swayp_auto", SWITCH_ON)).toBe("Encendido");
    expect(automationValueLabel("swayp_auto", SWITCH_OFF)).toBe("Apagado");
    expect(automationValueLabel("lima_retry:x", "simulacion")).toBe("Simulación");
    expect(automationValueLabel(RETRY_CAP_EVENT, "12")).toBe("12 guías al día");
    expect(automationValueLabel(RETRY_CAP_EVENT, null)).toBe("Sin configurar");
  });

  it("une nombres de tiendas en llano", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["Kenku Peru"])).toBe("Kenku Peru");
    expect(joinNames(["Kenku Peru", "Aurela"])).toBe("Kenku Peru y Aurela");
    expect(joinNames(["A", "B", "C"])).toBe("A, B y C");
  });
});

describe("el permiso y el menú", () => {
  it("«Encender y apagar automatizaciones»: lo tiene el owner, no el admin, y se da uno por uno", () => {
    expect(PERMISSIONS).toContain("automations.manage");
    expect(PERMISSION_LABEL["automations.manage"]).toBe("Encender y apagar automatizaciones");
    expect(permissionsFor(["owner"]).has("automations.manage")).toBe(true);
    expect(permissionsFor(["admin"]).has("automations.manage")).toBe(false);
    expect(permissionsFor(["vendedora"]).has("automations.manage")).toBe(false);
    expect(permissionsFor(["admin"], [{ permission: "automations.manage", granted: true }]).has("automations.manage")).toBe(true);
    const entry = GRANTED_ONE_BY_ONE.find((g) => g.permission === "automations.manage");
    expect(entry).toMatchObject({ ownerOnly: true, lastOneMatters: false });
  });

  it("la entrada del menú sigue al permiso y va junto a Equipo", () => {
    const access = { reports: true, catalog: true, mapAds: true, stores: true, costs: true, team: true, history: true };
    const withIt = navItems(false, false, false, { ...access, automations: true }).map((i) => i.href);
    expect(withIt[withIt.indexOf("/dashboard/team") + 1]).toBe("/dashboard/automatizaciones");
    expect(navItems(false, false, false, { ...access, automations: false }).map((i) => i.href)).not.toContain("/dashboard/automatizaciones");
    expect(navItems(true, false, false).map((i) => i.href)).not.toContain("/dashboard/automatizaciones");
  });
});
