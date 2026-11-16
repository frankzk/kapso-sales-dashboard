// Guía GF automática (MOM §29.17, owner 15-11-2026). Lo que se fija aquí: qué
// pedido entra a la pasada y por qué no; a qué horas corre; un intento por
// pedido y día; la alerta de Telegram; lo que la Simulación anticipa sin crear;
// que crea por la misma puerta que la Mesa de ruta; y que el panel, el MOM, el
// despliegue y la migración dicen lo mismo.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GF_AUTO_FAILED,
  GF_AUTO_FAILED_NOTE,
  GF_AUTO_FIRST_HOUR_LIMA,
  GF_AUTO_LAST_HOUR_LIMA,
  GF_AUTO_OUTCOMES,
  GF_AUTO_PASS_HOURS_LIMA,
  gfAutoActivoBlocker,
  gfAutoDayLine,
  gfAutoFailureTelegram,
  gfAutoModeFrom,
  gfAutoOutcomeLabel,
  gfAutoPassOpen,
  gfAutoSimulationDetail,
  gfAutoSkip,
  gfAutoTriedOn,
  gfCatalogProblem,
  isGfAutoOutcome,
  type GfAutoRow,
} from "@/lib/gf-auto-guide";
import {
  AUTOMATIONS,
  AUTOMATION_GROUPS,
  GF_AUTO_GUIDE_KEY,
  ORG_AUTOMATION_TABLES,
  ORG_TABLE_SHAPE,
  automationEventLabel,
  automationValueLabel,
  isWhitelisted,
  needsConfirmation,
} from "@/lib/automations-catalog";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const TODAY = "2026-11-16"; // lunes
const row = (over: Partial<GfAutoRow> = {}): GfAutoRow => ({
  dispatch_scheduled_on: TODAY,
  macro_stage: "preparacion",
  macro_substage: "por_generar_rotulo",
  shipping_mode: "cod",
  coverage: "lima",
  region: "Lima",
  province: "Lima",
  district: "Miraflores",
  ...over,
});

describe("qué pedido entra a la pasada", () => {
  it("Lima, Por generar rótulo, programado para hoy", () => {
    expect(gfAutoSkip(row(), TODAY)).toBeNull();
  });

  it("sin fecha programada también entra", () => {
    expect(gfAutoSkip(row({ dispatch_scheduled_on: null }), TODAY)).toBeNull();
    expect(gfAutoSkip(row({ dispatch_scheduled_on: undefined }), TODAY)).toBeNull();
  });

  it("programado para otro día no: ni uno que viene ni uno que ya pasó", () => {
    expect(gfAutoSkip(row({ dispatch_scheduled_on: "2026-11-17" }), TODAY)).toBe("otro_dia");
    // Su día pasó sin guía: la chapa roja «no salió» es para una persona.
    expect(gfAutoSkip(row({ dispatch_scheduled_on: "2026-11-15" }), TODAY)).toBe("otro_dia");
  });

  it("fuera de Preparación · Por generar rótulo no: ya tiene guía, o viaja en la caja de otro pedido", () => {
    expect(gfAutoSkip(row({ macro_substage: "por_armar" }), TODAY)).toBe("otra_etapa");
    expect(gfAutoSkip(row({ macro_substage: "en_caja_de_otro_pedido" }), TODAY)).toBe("otra_etapa");
    expect(gfAutoSkip(row({ macro_stage: "por_despachar", macro_substage: "por_despachar" }), TODAY)).toBe("otra_etapa");
  });

  it("Agencia y Provincia no van por GF Courier (`classifyOperation`)", () => {
    expect(gfAutoSkip(row({ shipping_mode: "agency" }), TODAY)).toBe("no_lima");
    expect(gfAutoSkip(row({ coverage: "agencia" }), TODAY)).toBe("no_lima");
    expect(gfAutoSkip(row({ coverage: "provincia_cod", region: "Arequipa", province: "Arequipa", district: "Cayma" }), TODAY)).toBe("no_lima");
    // Las provincias de Lima fuera de la capital son Agencia aunque digan «lima».
    expect(gfAutoSkip(row({ province: "Cañete", district: "San Vicente de Cañete" }), TODAY)).toBe("no_lima");
  });

  it("programado con otro courier no (0348, Repro Lima 16-11-2026): sale con el elegido", () => {
    expect(gfAutoSkip(row({ dispatch_scheduled_on: TODAY, dispatch_courier: "aliclik" }), TODAY)).toBe("otro_courier");
    expect(gfAutoSkip(row({ dispatch_scheduled_on: TODAY, dispatch_courier: "fenix" }), TODAY)).toBe("otro_courier");
    expect(gfAutoSkip(row({ dispatch_scheduled_on: TODAY, dispatch_courier: "propio" }), TODAY)).toBe("otro_courier");
    expect(gfAutoSkip(row({ dispatch_scheduled_on: TODAY, dispatch_courier: "gf_courier" }), TODAY)).toBeNull();
    expect(gfAutoSkip(row({ dispatch_scheduled_on: TODAY, dispatch_courier: null }), TODAY)).toBeNull();
  });

  it("Callao es Lima", () => {
    expect(gfAutoSkip(row({ coverage: null, region: "Callao", province: "Callao", district: "Bellavista" }), TODAY)).toBeNull();
  });
});

describe("cuándo corre", () => {
  it("a las 9:00, 10:00 y 11:00 de Lima", () => {
    expect([...GF_AUTO_PASS_HOURS_LIMA]).toEqual([9, 10, 11]);
    expect(GF_AUTO_FIRST_HOUR_LIMA).toBe(9);
    expect(GF_AUTO_LAST_HOUR_LIMA).toBe(11);
  });

  it("solo crea de 9:00 a 11:59 de Lima", () => {
    for (const h of [0, 7, 8, 12, 13, 18, 23]) expect(gfAutoPassOpen(h), String(h)).toBe(false);
    for (const h of [9, 10, 11]) expect(gfAutoPassOpen(h), String(h)).toBe(true);
  });

  it("vercel.json: 14, 15 y 16 UTC (Lima es UTC−5), en el minuto 0", () => {
    const cfg = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    const cron = cfg.crons.find((c) => c.path === "/api/cron/gf-auto-guide");
    expect(cron?.schedule).toBe("0 14,15,16 * * *");
    expect(cron?.schedule).toBe(`0 ${GF_AUTO_PASS_HOURS_LIMA.map((h) => h + 5).join(",")} * * *`);
  });

  it("la ruta: secreto del cron, y solo en producción salvo `?dry=1`", () => {
    const route = read("app/api/cron/gf-auto-guide/route.ts");
    expect(route).toContain("internalAuthorized(req)");
    expect(route).toContain('if (!dry && process.env.VERCEL_ENV !== "production")');
    expect(route).toContain("runGfAutoGuides(createAdminSupabase(), { dry })");
    expect(route).toContain("export const maxDuration = 300;");
  });

  it("la pasada mira la hora antes de leer nada", () => {
    const runner = read("lib/gf-auto-guide-server.ts");
    const fn = runner.slice(runner.indexOf("export async function runGfAutoGuides("));
    expect(fn.indexOf("if (!dry && !gfAutoPassOpen(limaHour))")).toBeGreaterThan(-1);
    expect(fn.indexOf("if (!dry && !gfAutoPassOpen(limaHour))")).toBeLessThan(fn.indexOf("loadGfReadyStores(admin"));
  });
});

describe("un intento por pedido y día", () => {
  const failed = (date: string) => ({ kind: GF_AUTO_FAILED, payload: { date } });

  it("si falló hoy, ya no lo intenta: lo toma una persona", () => {
    expect(gfAutoTriedOn([failed(TODAY)], TODAY)).toBe(true);
  });

  it("al día siguiente vuelve a ser suyo", () => {
    expect(gfAutoTriedOn([failed("2026-11-15")], TODAY)).toBe(false);
  });

  it("solo cuenta su propio hecho", () => {
    expect(gfAutoTriedOn([{ kind: "aliclik_auto_guide_failed", payload: { date: TODAY } }], TODAY)).toBe(false);
    expect(gfAutoTriedOn([{ kind: GF_AUTO_FAILED, payload: null }], TODAY)).toBe(false);
    expect(gfAutoTriedOn([], TODAY)).toBe(false);
  });

  it("la pasada lo comprueba antes de mirar guías o crear, y sin poder leerlo no crea nada", () => {
    const runner = read("lib/gf-auto-guide-server.ts");
    const fn = runner.slice(runner.indexOf("export async function runGfAutoGuides("));
    expect(fn).toContain('.eq("kind", GF_AUTO_FAILED)');
    expect(fn).toContain("No se pudo verificar qué pedidos ya se intentaron hoy o viajan en la caja de otro");
    const tried = fn.indexOf("if (gfAutoTriedOn(");
    expect(tried).toBeGreaterThan(-1);
    expect(tried).toBeLessThan(fn.indexOf("createGfGuideFor(row.order_id"));
    expect(tried).toBeLessThan(fn.indexOf("previewGfGuide(admin, row"));
  });
});

describe("el acompañante no recibe guía propia (§32)", () => {
  const runner = read("lib/gf-auto-guide-server.ts");
  const fn = runner.slice(runner.indexOf("export async function runGfAutoGuides("));

  it("se leen los vínculos de todos los candidatos, y vinculado cuenta aunque su caja ya no preste", () => {
    expect(fn).toContain("loadCompanionRides(admin, ids)");
    expect(fn).toContain("if (idSet.has(ride.link.companionOrderId)) companions.add(ride.link.companionOrderId);");
    // No se filtra por `ride.shipment`: la caja anulada sin salir tampoco lo libera (§32.1, regla 8).
    expect(fn).not.toContain("ride.shipment");
  });

  it("antes de mirar guías, simular o crear", () => {
    const companion = fn.indexOf("if (companions.has(row.order_id))");
    expect(companion).toBeGreaterThan(-1);
    expect(companion).toBeLessThan(fn.indexOf("activeAliclikBlocker(admin, row.order_id)"));
    expect(companion).toBeLessThan(fn.indexOf("createGfGuideFor(row.order_id"));
  });
});

describe("crea por la misma puerta que la Mesa de ruta", () => {
  const runner = read("lib/gf-auto-guide-server.ts");
  const fn = runner.slice(runner.indexOf("export async function runGfAutoGuides("), runner.indexOf("// ── El panel"));

  it("con `createGfGuideFor`, como sistema, y nunca con el cliente de GF a pelo", () => {
    expect(runner.startsWith('import "server-only";')).toBe(true);
    expect(fn).toContain("createGfGuideFor(row.order_id, { userId: null, reason: GF_AUTO_GUIDE_REASON }, admin)");
    expect(runner).not.toContain("gfCourier.createOrder");
    expect(runner).not.toMatch(/from\("gf_order_requests"\)\.(insert|update|upsert)/);
  });

  it("solo las tiendas con las dos llaves de la tienda, y Activo solo con la del servidor", () => {
    expect(runner).toContain('.eq("status", "active").eq("gf_courier_enabled", true)');
    expect(runner).toContain("if (gf?.enabled && gf.token)");
    expect(fn).toContain('return dry || mode === "simulacion" || (mode === "activo" && writeOk);');
    expect(fn).toContain("GF_COURIER_WRITE_ENABLED está apagado: en Activo no se crea nada");
  });

  it("los pedidos: Por generar rótulo, de hoy o sin fecha, y la regla pura decide", () => {
    expect(fn).toContain('.eq("macro_stage", "preparacion")');
    expect(fn).toContain('.eq("macro_substage", "por_generar_rotulo")');
    expect(fn).toContain(".or(`dispatch_scheduled_on.is.null,dispatch_scheduled_on.eq.${today}`)");
    expect(fn).toContain(".filter((row) => gfAutoSkip(row, today) === null)");
  });

  it("justo antes de crear mira la guía viva de cualquier courier y la creación GF pendiente", () => {
    const create = fn.indexOf("createGfGuideFor(row.order_id");
    expect(fn.indexOf("activeAliclikBlocker(admin, row.order_id)")).toBeLessThan(create);
    expect(fn.indexOf("pendingGfIntent(admin, row.order_id)")).toBeLessThan(create);
    // Ya con guía no es un fallo: se recalcula el Master.
    const live = fn.slice(fn.indexOf("if (live.guide) {"));
    expect(live.slice(0, live.indexOf("continue;"))).toContain("recomputeOrderMasterSafe(admin, [row.order_id])");
    expect(live.slice(0, live.indexOf("continue;"))).not.toContain("fail(");
  });

  it("un timeout o una creación de otro no es un fallo: no avisa", () => {
    const pending = fn.slice(fn.indexOf("if (result.pending) {"));
    expect(pending.slice(0, pending.indexOf("continue;"))).not.toContain("fail(");
    // Si otra creación ganó la carrera, tampoco.
    const after = fn.slice(fn.indexOf("const after = await activeAliclikBlocker(admin, row.order_id);"));
    expect(after.indexOf("fail(result.error")).toBeGreaterThan(after.indexOf("if (busy.pending) {"));
  });

  it("el fallo avisa por Telegram y queda en el historial con fecha, solo en Activo", () => {
    expect(runner).toContain("kind: GF_AUTO_FAILED,");
    expect(runner).toContain("payload: {\n      date: today,\n      policy: GF_AUTO_POLICY,\n      telegram,");
    expect(runner).toContain("sendTelegramToAll(");
    expect(runner).toContain("telegramTarget(admin, row.store_id)");
    const fail = fn.slice(fn.indexOf("const fail = async"), fn.indexOf("if (gfAutoTriedOn("));
    expect(fail).toContain("if (!simulate) {");
    expect(fail.indexOf("recordFailure(")).toBeGreaterThan(fail.indexOf("if (!simulate) {"));
  });
});

describe("Simulación: dice qué guía habría creado, sin crear nada afuera", () => {
  const runner = read("lib/gf-auto-guide-server.ts");
  const preview = runner.slice(runner.indexOf("async function previewGfGuide("), runner.indexOf("export async function runGfAutoGuides("));
  const core = read("lib/gf-courier-guide.ts");

  it("la vista previa solo lee: ni POST a GF, ni escrituras", () => {
    expect(preview).not.toMatch(/createOrder|createGfGuideFor|\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
    expect(preview).toContain("gfCatalogProblem(built.input.items.map((item) => item.sku), read.products)");
    // El catálogo de GF se lee una vez por tienda y pasada, con GET /v1/products.
    expect(runner).toContain("read = loadGfProducts(store.token)");
  });

  it("hace las MISMAS lecturas que la creación hasta antes del POST", () => {
    for (const piece of [
      '.select("id,delivery_status,returned_at").eq("order_id", orderId).eq("courier", GF_COURIER)',
      '["pendiente", "en_ruta"].includes(s.delivery_status) && !s.returned_at',
      '.from("orders").select("name,line_items,raw").eq("id", orderId)',
      '.in("kind", [...CUSTOMER_PAYMENT_KINDS]).eq("validation_status", "validado")',
      "const sequence = (shipments.data ?? []).length + 1;",
      "sequence > 1 ? `-S${sequence}` : \"\"",
      "ubigeo: wooTerritorio(order.data.raw)?.code ?? null",
      "buildGfOrderInput({",
    ]) {
      expect(core, `creación: ${piece}`).toContain(piece);
      expect(preview, `simulación: ${piece}`).toContain(piece);
    }
  });

  it("la pasada simula antes de llegar a crear, y en Simulación no avisa ni deja hecho", () => {
    const fn = runner.slice(runner.indexOf("export async function runGfAutoGuides("));
    expect(fn.indexOf("if (simulate) {")).toBeLessThan(fn.indexOf("createGfGuideFor(row.order_id"));
    expect(fn).toContain('const simulate = dry || mode !== "activo";');
  });

  it("deja un renglón por pedido, día y modo, como los reintentos de Lima; con `?dry=1`, nada", () => {
    expect(runner).toContain('{ onConflict: "order_id,lima_day,mode" }');
    expect(runner).toContain("if (dry || !isGfAutoOutcome(item.outcome)) return;");
  });

  it("los SKU que GF no tiene o tiene Agotados, antes de crear", () => {
    const gf = [
      { merchant_sku: "AUR-001", name: "Faja", sales_status: "IN_STOCK" },
      { merchant_sku: "AUR-002", name: "Bóxer", sales_status: "OUT_OF_STOCK" },
    ];
    expect(gfCatalogProblem(["AUR-001"], gf)).toBeNull();
    expect(gfCatalogProblem(["aur-001 "], gf)).toBeNull();
    expect(gfCatalogProblem(["AUR-009"], gf)).toBe("GF no tiene en su catálogo el SKU AUR-009: respondería SKU_NOT_FOUND.");
    expect(gfCatalogProblem(["AUR-009", "AUR-010", "AUR-009"], gf)).toBe(
      "GF no tiene en su catálogo los SKU AUR-009, AUR-010: respondería SKU_NOT_FOUND.",
    );
    expect(gfCatalogProblem(["AUR-001", "AUR-002"], gf)).toBe("GF tiene Agotado el SKU AUR-002: respondería OUT_OF_STOCK.");
  });

  it("lo que dice de la guía que habría creado", () => {
    expect(gfAutoSimulationDetail({ amountToCollect: 89, units: 2, district: "Miraflores" })).toBe("Cobraría S/ 89.00 · 2 productos · Miraflores.");
    expect(gfAutoSimulationDetail({ amountToCollect: 0, units: 1, district: null })).toBe("Sin cobro en la puerta (pagado) · 1 producto.");
    expect(gfAutoSimulationDetail({ amountToCollect: 50.5, units: 1, district: " Surco ", catalogNote: "No se pudo leer el catálogo de GF." })).toBe(
      "Cobraría S/ 50.50 · 1 producto · Surco. No se pudo leer el catálogo de GF.",
    );
  });
});

describe("la alerta de Telegram", () => {
  const base = {
    storeName: "Aurela",
    orderName: "#AUR900859",
    customerName: "María <Pérez>",
    place: "Miraflores, Lima",
    date: TODAY,
    scheduled: true,
    error: "Hay un producto sin SKU: GF solo despacha productos de su catálogo.",
    url: "https://kapta.example/dashboard/pedidos?abrir=abc",
  };

  it("dice qué pedido, qué día, por qué, que hoy no se repite y dónde abrirlo", () => {
    const text = gfAutoFailureTelegram(base);
    expect(text).toContain("<b>Aurela</b> · guía GF Courier automática no creada");
    expect(text).toContain("<b>#AUR900859</b>");
    expect(text).toContain("Programado para hoy, lun 16/11.");
    expect(text).toContain("Motivo: Hay un producto sin SKU: GF solo despacha productos de su catálogo.");
    expect(text).toContain("Hoy no se vuelve a intentar. Créala a mano desde la Mesa de ruta:");
    expect(text).toContain("https://kapta.example/dashboard/pedidos?abrir=abc");
  });

  it("un pedido sin fecha dice que entró por la pasada de hoy", () => {
    expect(gfAutoDayLine(TODAY, false)).toBe("Sin fecha programada: entró en la pasada de hoy, lun 16/11.");
    expect(gfAutoFailureTelegram({ ...base, scheduled: false })).toContain("Sin fecha programada: entró en la pasada de hoy, lun 16/11.");
  });

  it("escapa lo que escribió la clienta", () => {
    expect(gfAutoFailureTelegram(base)).toContain("María &lt;Pérez&gt;");
  });

  it("recorta un motivo larguísimo: el resto está en el historial", () => {
    const text = gfAutoFailureTelegram({ ...base, error: "x".repeat(2000) });
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(1000);
  });

  it("el hecho del historial dice qué hacer", () => {
    expect(GF_AUTO_FAILED).toBe("gf_auto_guide_failed");
    expect(GF_AUTO_FAILED_NOTE).toContain("Hoy no se vuelve a intentar");
    expect(read("components/order-master-shared.tsx")).toContain('gf_auto_guide_failed: "Guía GF automática no creada"');
    expect(read("lib/order-timeline-fact.ts")).toContain('gf_auto_guide_failed: consulta("guia")');
  });
});

describe("las tres posiciones", () => {
  it("nace Apagado; un valor raro o sin fila, Apagado", () => {
    expect(gfAutoModeFrom(undefined)).toBe("apagado");
    expect(gfAutoModeFrom(null)).toBe("apagado");
    expect(gfAutoModeFrom("encendido")).toBe("apagado");
    expect(gfAutoModeFrom("simulacion")).toBe("simulacion");
    expect(gfAutoModeFrom("activo")).toBe("activo");
  });

  it("Activo no se elige sin la llave del servidor ni sin una tienda con GF Courier por API", () => {
    expect(gfAutoActivoBlocker({ writeEnabled: true, readyStores: 1 })).toBeNull();
    expect(gfAutoActivoBlocker({ writeEnabled: false, readyStores: 2 })).toMatch(/GF_COURIER_WRITE_ENABLED/);
    expect(gfAutoActivoBlocker({ writeEnabled: true, readyStores: 0 })).toMatch(/^Ninguna tienda tiene GF Courier por API/);
  });

  it("lo que queda en «Hoy y ayer»", () => {
    expect([...GF_AUTO_OUTCOMES]).toEqual(["simulada", "creada", "fallo", "en_curso"]);
    expect(isGfAutoOutcome("creada")).toBe(true);
    expect(isGfAutoOutcome("ya_intentado")).toBe(false);
    expect(gfAutoOutcomeLabel("fallo", "simulacion")).toBe("No la crearía");
    expect(gfAutoOutcomeLabel("fallo", "activo")).toBe("No se pudo crear");
    expect(gfAutoOutcomeLabel("simulada", "simulacion")).toBe("Habría creado la guía");
  });
});

describe("el panel de Automatizaciones", () => {
  const entry = AUTOMATIONS.find((e) => e.key === GF_AUTO_GUIDE_KEY)!;

  it("en «Logística Lima», con tres posiciones y fuera de la lista blanca de interruptores", () => {
    expect(GF_AUTO_GUIDE_KEY).toBe("gf_auto_guide");
    expect(entry.name).toBe("Guía GF automática");
    expect(entry.group).toBe("logistica_lima");
    expect(AUTOMATION_GROUPS.find((g) => g.key === "logistica_lima")?.title).toBe("Logística Lima");
    expect(entry.control).toEqual({ kind: "org_mode", table: "gf_auto_guide_settings", column: "mode" });
    expect(entry.scope).toBe("org");
    expect(ORG_AUTOMATION_TABLES).toContain("gf_auto_guide_settings");
    expect(ORG_TABLE_SHAPE.gf_auto_guide_settings.columns).toEqual(["mode"]);
    expect(isWhitelisted("gf_auto_guide_settings", "mode")).toBe(false);
    expect(entry.link).toEqual({ kind: "store_settings", section: "gf-courier", label: "Ajustes de la tienda" });
  });

  it("crea guías: Activo pide confirmación, como las demás", () => {
    expect(entry.effect).toBe("Crea guías");
    expect(needsConfirmation(entry)).toBe(true);
    const panel = read("components/automations-panel.tsx");
    expect(panel).toContain('if (next === "activo" && !window.confirm(GF_ACTIVE_CONFIRM)) return false;');
    expect(panel).toContain("const result = await setGfAutoGuideMode(orgId, next);");
    expect(panel).toContain("<GfAutoGuideRow");
    expect(panel).toContain('{group.key === "logistica_lima" && <GfAutoLogCard view={org.gfAutoGuide} />}');
    // Cuenta entre las encendidas solo en Activo y si de verdad corre.
    expect(panel).toContain('org.gfAutoGuide.mode === "activo" && !org.gfAutoGuide.blocker');
  });

  it("la acción: permiso y producción, solo su columna, el bloqueo de Activo y su fila en el historial", () => {
    const actions = read("app/dashboard/automatizaciones/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function setGfAutoGuideMode("));
    expect(fn).toContain("const g = await gate(orgId);");
    expect(fn).toContain("if (!isApproxMode(mode))");
    expect(fn).toContain(".from(GF_AUTO_SETTINGS)");
    expect(fn).toContain('.upsert({ org_id: orgId, mode, updated_by: g.actor, updated_at: new Date().toISOString() }, { onConflict: "org_id" })');
    expect(fn).toContain("gfAutoActivoBlocker({ writeEnabled: env.gfCourierWriteEnabled(), readyStores: ready.stores.length })");
    expect(fn.indexOf("gfAutoActivoBlocker(")).toBeLessThan(fn.indexOf(".upsert("));
    expect(fn).toContain("automation: GF_AUTO_GUIDE_KEY,");
    expect(actions).toContain('const MISSING_0345 = "Falta la migración 0345 en la base de datos.";');
    expect(fn).toContain("return { error: MISSING_0345 };");
  });

  it("«Últimos cambios» la nombra y dice la posición en palabras", () => {
    expect(automationEventLabel(GF_AUTO_GUIDE_KEY)).toBe("Guía GF automática");
    expect(automationValueLabel(GF_AUTO_GUIDE_KEY, "simulacion")).toBe("Simulación");
    expect(automationValueLabel(GF_AUTO_GUIDE_KEY, "activo")).toBe("Activo");
  });
});

describe("la migración 0345", () => {
  const sql = read("db/migrations/0345_gf_auto_guide.sql");

  it("crea sus dos tablas, aditiva y repetible", () => {
    expect(sql).toContain("create table if not exists public.gf_auto_guide_settings (");
    expect(sql).toContain("create table if not exists public.gf_auto_guide_log (");
    expect(sql).toContain("mode        text not null default 'apagado',");
    expect(sql).not.toMatch(/\bdrop\s+(table|column)\b/i);
    expect(sql).not.toMatch(/\b(update|delete from|insert into)\s+public\./i);
  });

  it("sus valores se cierran con un check que se puede volver a crear", () => {
    expect(sql).toContain("drop constraint if exists gf_auto_guide_settings_mode_check;");
    expect(sql).toContain("check (mode in ('apagado', 'simulacion', 'activo'))");
    expect(sql).toContain("drop constraint if exists gf_auto_guide_log_mode_check;");
    expect(sql).toContain("check (mode in ('simulacion', 'activo'))");
    expect(sql).toContain("drop constraint if exists gf_auto_guide_log_outcome_check;");
    expect(sql).toContain(`check (outcome in (${GF_AUTO_OUTCOMES.map((o) => `'${o}'`).join(", ")}))`);
    expect(sql).toContain("on public.gf_auto_guide_log (order_id, lima_day, mode);");
  });

  it("RLS como los reintentos de Lima (0306): la organización lee, solo el servidor escribe", () => {
    expect(sql).toContain("alter table public.gf_auto_guide_settings enable row level security;");
    expect(sql).toContain("alter table public.gf_auto_guide_log enable row level security;");
    expect(sql).toContain("for select to authenticated using (org_id in (select auth_org_ids()));");
    expect(sql).toContain("for select to authenticated using (store_id in (select auth_store_ids()));");
    expect(sql).toContain("revoke all on public.gf_auto_guide_settings, public.gf_auto_guide_log from anon, authenticated;");
    expect(sql).toContain("grant all on public.gf_auto_guide_settings, public.gf_auto_guide_log to service_role;");
    expect(sql).not.toMatch(/for (insert|update|delete|all) to authenticated/);
  });

  it("los bundles la incluyen", () => {
    expect(read("db/apply.sql")).toContain("\\ir migrations/0345_gf_auto_guide.sql");
    expect(read("db/apply_bundled.sql")).toContain("create table if not exists public.gf_auto_guide_settings (");
  });
});

describe("el MOM y el despliegue", () => {
  it("el MOM lo dice en §29.17 y en §40", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    const gf = mom.indexOf("### 29.17 GF Courier por API");
    const sub = mom.indexOf("#### Guía GF automática (owner, 15-11-2026)");
    expect(sub).toBeGreaterThan(gf);
    expect(sub).toBeLessThan(mom.indexOf("## 30. Liquidaciones 2"));
    const body = mom.slice(sub, mom.indexOf("## 30. Liquidaciones 2")).replace(/\s+/g, " ");
    expect(body).toContain("`0 14,15,16 * * *`");
    expect(body).toContain("`gf_auto_guide_failed`");
    expect(body).toContain("**Un intento por pedido y día**");
    expect(body).toContain("Nace **Apagado**");
    const panel = mom.slice(mom.indexOf("## 40. Panel de automatizaciones"), mom.indexOf("## 41. Lista negra")).replace(/\s+/g, " ");
    expect(panel).toContain("«Guía GF automática» (§29.17, 15-11-2026; 0345, clave `gf_auto_guide`");
    expect(panel).toContain("`0345_gf_auto_guide.sql`");
  });

  it("DEPLOY.md: justo después de la 0344, la 0345 y la 0346 antes que el código y nace Apagado", () => {
    const deploy = read("DEPLOY.md");
    const first = deploy.indexOf("### ");
    const second = deploy.indexOf("\n### ", first + 4) + 1;
    expect(deploy.slice(first, second)).toContain("0344_gf_courier_api");
    const entry = deploy.slice(second, deploy.indexOf("\n### ", second + 4));
    expect(entry).toContain("### 15-11-2026 · Guía GF automática");
    expect(entry).toContain("`0345_gf_auto_guide.sql` y `0346_gf_requests_lock_en_curso.sql`: ya aplicadas en producción");
    expect(entry).toMatch(/antes del código/);
    expect(entry).toContain("/api/cron/gf-auto-guide");
    expect(entry).toContain("**Nace Apagado en todas las organizaciones**");
  });
});

describe("0346: el candado de GF cuenta solo la creación en curso", () => {
  it("rehace el índice parcial con status = 'pending' para que la -S2 no choque", () => {
    const sql = read("db/migrations/0346_gf_requests_lock_en_curso.sql");
    expect(sql).toContain("drop index if exists public.gf_order_requests_live_uniq");
    expect(sql).toMatch(/on public\.gf_order_requests \(order_id\) where status = 'pending'/);
    expect(read("docs/mom/master-pedidos-v1.md")).toContain("una **en curso** por pedido");
  });
});
