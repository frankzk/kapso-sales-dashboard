import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALICLIK_AUTO_FAILED,
  AUTO_GUIDE_HINT,
  FIRST_PASS_HOUR_LIMA,
  LAST_PASS_HOUR_LIMA,
  autoGuideReason,
  autoTransport,
  scheduledFailureTelegram,
  scheduledHold,
  scheduledSkip,
  triedOn,
  waitForAliclik,
  type ScheduledRow,
} from "@/lib/aliclik-scheduled";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const TODAY = "2026-10-26";
const row = (over: Partial<ScheduledRow> = {}): ScheduledRow => ({
  dispatch_scheduled_on: TODAY,
  macro_stage: "preparacion",
  macro_substage: "por_generar_rotulo",
  shipping_mode: "cod",
  coverage: "provincia_cod",
  region: "Arequipa",
  province: "Arequipa",
  district: "Cayma",
  ...over,
});

describe("qué pedido entra a la pasada", () => {
  it("Provincia COD, Por generar rótulo, programado para hoy", () => {
    expect(scheduledSkip(row(), TODAY)).toBeNull();
  });

  it("sin fecha, o con otra fecha, no es suyo", () => {
    expect(scheduledSkip(row({ dispatch_scheduled_on: null }), TODAY)).toBe("otro_dia");
    expect(scheduledSkip(row({ dispatch_scheduled_on: "2026-10-27" }), TODAY)).toBe("otro_dia");
    // Uno vencido tampoco: si su día pasó sin guía, ya lo tiene que ver una persona.
    expect(scheduledSkip(row({ dispatch_scheduled_on: "2026-10-25" }), TODAY)).toBe("otro_dia");
  });

  it("fuera de Preparación · Por generar rótulo, no", () => {
    expect(scheduledSkip(row({ macro_substage: "por_armar" }), TODAY)).toBe("otra_etapa");
    expect(scheduledSkip(row({ macro_stage: "por_confirmar", macro_substage: "por_contactar" }), TODAY)).toBe("otra_etapa");
  });

  it("Lima y Agencia no van por Aliclik", () => {
    expect(scheduledSkip(row({ coverage: "lima", region: "Lima", province: "Lima" }), TODAY)).toBe("no_provincia_cod");
    expect(scheduledSkip(row({ shipping_mode: "agency" }), TODAY)).toBe("no_provincia_cod");
    expect(scheduledSkip(row({ coverage: "agencia" }), TODAY)).toBe("no_provincia_cod");
  });
});

describe("lo que es de una persona: el incidente del 18 y 19-10-2026", () => {
  const AYER = "2026-10-25T20:00:00Z"; // dom 25/10, 3:00 p. m. de Lima
  const base = { hasShalomDraft: false, paymentState: null, scheduledAt: AYER, todayLima: TODAY };

  it("programado otro día, sin Shalom ni pago: es del automático", () => {
    expect(scheduledHold(base)).toBeNull();
    expect(scheduledHold({ ...base, paymentState: "sin_pago" })).toBeNull();
  });

  it("con «DNI y agencia Shalom» guardado no se toca (#KP140883, #KP142598, #KP142667, #KP142743)", () => {
    expect(scheduledHold({ ...base, hasShalomDraft: true })).toBe("shalom");
  });

  it("con un pago registrado no se toca: Aliclik cobraría el total aunque ya se adelantó", () => {
    for (const state of ["adelanto_cargado", "adelanto_validado", "diferencia_cargada", "pago_completo"]) {
      expect(scheduledHold({ ...base, paymentState: state })).toBe("con_pago");
    }
  });

  it("con la fecha acordada hoy no se toca: #KP142443 se confirmó a la 1:05 y la pasada de la 1:07 le creó la guía", () => {
    // 26/10 a la 1:05 p. m. de Lima = 18:05 UTC, el mismo día que sale.
    expect(scheduledHold({ ...base, scheduledAt: "2026-10-26T18:05:00Z" })).toBe("programado_hoy");
    // Sin saber cuándo se programó, tampoco.
    expect(scheduledHold({ ...base, scheduledAt: null })).toBe("programado_hoy");
  });

  it("la pasada lo comprueba antes de cotizar o crear, y sin poder leerlo no crea nada", () => {
    const runner = read("lib/aliclik-scheduled-server.ts");
    expect(runner).toContain('admin.from("shalom_order_drafts").select("order_id").in("order_id", candidateIds)');
    expect(runner).toContain("No se pudo verificar si los pedidos van por Shalom o se programaron hoy");
    const hold = runner.indexOf("const hold = scheduledHold({");
    expect(hold).toBeGreaterThan(-1);
    expect(hold).toBeLessThan(runner.indexOf("previewAliclikGuideFor(ctx"));
    expect(hold).toBeLessThan(runner.indexOf("createAliclikGuideFor("));
  });

  it("el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("**Lo que es de una persona y el automático no toca (20-10-2026).**");
    expect(mom).toContain("**Ocurrió el 18 y 19-10-2026.**");
  });
});

describe("con qué transportadora", () => {
  const q = (transportId: number, deliveryCost: number, selectable = true) => ({ transportId, deliveryCost, selectable });

  it("la más barata de las que se pueden agendar, como el panel", () => {
    expect(autoTransport([q(1, 14), q(2, 9), q(3, 12)])?.transportId).toBe(2);
  });

  it("un express fuera de su ventana no cuenta aunque sea más barato", () => {
    expect(autoTransport([q(1, 14), q(2, 5, false)])?.transportId).toBe(1);
  });

  it("sin ninguna agendable, ninguna", () => {
    expect(autoTransport([q(1, 5, false)])).toBeNull();
    expect(autoTransport([])).toBeNull();
    expect(autoTransport(undefined)).toBeNull();
  });
});

describe("un intento por pedido y fecha", () => {
  const failed = (date: string) => ({ kind: ALICLIK_AUTO_FAILED, payload: { date } });

  it("si falló para esa fecha, ya no lo intenta", () => {
    expect(triedOn([failed(TODAY)], TODAY)).toBe(true);
  });

  it("reprogramado a otro día, vuelve a ser suyo ese día", () => {
    expect(triedOn([failed("2026-10-19")], TODAY)).toBe(false);
  });

  it("solo cuenta su propio hecho", () => {
    expect(triedOn([{ kind: "dispatch_date_set", payload: { date: TODAY } }], TODAY)).toBe(false);
    expect(triedOn([], TODAY)).toBe(false);
  });
});

describe("con Aliclik en rojo se espera, salvo en la última pasada", () => {
  const ok = { quote: "operativo", create: "ok" };

  it("sano, no espera", () => {
    expect(waitForAliclik(ok, 9)).toBe(false);
    expect(waitForAliclik({ quote: "sin_monitoreo", create: "sin_datos" }, 9)).toBe(false);
  });

  it("cotización caída o creaciones fallando: espera a la hora siguiente", () => {
    expect(waitForAliclik({ ...ok, quote: "fallos" }, 9)).toBe(true);
    expect(waitForAliclik({ ...ok, create: "degradado" }, 12)).toBe(true);
  });

  it("en la última pasada se intenta igual: lo que falle avisa", () => {
    expect(waitForAliclik({ ...ok, quote: "fallos" }, LAST_PASS_HOUR_LIMA)).toBe(false);
  });
});

describe("la alerta de Telegram", () => {
  const base = {
    storeName: "Aurela",
    orderName: "#KP140347",
    customerName: "María <Pérez>",
    place: "Cayma, Arequipa",
    date: TODAY,
    error: "Falta validar el pago exigido.",
    url: "https://kapta.example/dashboard/pedidos?abrir=abc",
  };

  it("dice qué pedido, para cuándo, por qué y dónde abrirlo", () => {
    const text = scheduledFailureTelegram(base);
    expect(text).toContain("<b>Aurela</b> · guía Aliclik programada no creada");
    expect(text).toContain("<b>#KP140347</b>");
    expect(text).toContain("Programado para hoy, lun 26/10.");
    expect(text).toContain("Motivo: Falta validar el pago exigido.");
    expect(text).toContain("https://kapta.example/dashboard/pedidos?abrir=abc");
  });

  it("escapa lo que escribió la clienta", () => {
    expect(scheduledFailureTelegram(base)).toContain("María &lt;Pérez&gt;");
  });

  it("recorta un motivo larguísimo: el resto está en el historial", () => {
    const text = scheduledFailureTelegram({ ...base, error: "x".repeat(2000) });
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(1000);
  });
});

it("el motivo de la guía automática dice el día", () => {
  expect(autoGuideReason(TODAY)).toBe("Guía automática: envío programado para el lun 26/10.");
});

describe("pasa por la misma puerta que el botón", () => {
  const core = read("lib/aliclik-guide.ts");
  const actions = read("app/dashboard/pedidos/aliclik-actions.ts");
  const runner = read("lib/aliclik-scheduled-server.ts");

  it("el núcleo no es un archivo de acciones: no se puede invocar desde un navegador", () => {
    expect(core.startsWith('import "server-only";')).toBe(true);
    expect(core).not.toMatch(/^["']use server["'];?$/m);
    expect(actions.startsWith('"use server";')).toBe(true);
  });

  it("el botón autoriza y luego crea, sin firmar como automático", () => {
    const create = actions.slice(actions.indexOf("export async function createAliclikGuide("));
    expect(create.indexOf('authorize(orderId, "aliclik.create_guide")')).toBeGreaterThan(-1);
    expect(create.indexOf('authorize(orderId, "aliclik.create_guide")')).toBeLessThan(create.indexOf("createAliclikGuideFor("));
    expect(create).toContain("createAliclikGuideFor(ctx, input);");
  });

  it("lo que manda el navegador no puede decir «automática»", () => {
    const input = core.slice(core.indexOf("export interface CreateGuideInput {"), core.indexOf("const INTENT_EXPIRY_MS"));
    expect(input).not.toMatch(/origin|auto|scheduled/i);
  });

  it("el automático crea con el núcleo y nunca escribe una excepción", () => {
    expect(runner).toContain("createAliclikGuideFor(");
    expect(runner).toContain("previewAliclikGuideFor(ctx, { modality: \"cod\" }, scope)");
    expect(runner).toContain("aliclikContextFor(row, null, { blockAgencia: true })");
    expect(runner).not.toContain("ExceptionReason");
    expect(runner).not.toMatch(/from\("aliclik_order_requests"\)/);
  });

  it("sin sesión, el historial del cliente se acota a la organización", () => {
    const brief = read("lib/orders-master-access.ts");
    expect(brief).toContain('if (scope) query = query.in("store_id", [...scope.storeIds]);');
    expect(core).toContain('admin.from("stores").select("id").eq("org_id", orgId)');
  });

  it("un pedido que otra creación tiene en curso no avisa", () => {
    expect(core).toContain("return { error: await describeLockedIntent(admin, orderId), locked: true };");
    const locked = runner.slice(runner.indexOf("if (result.locked) {"));
    expect(locked.slice(0, locked.indexOf("}"))).not.toContain("fail(");
  });

  it("el fallo avisa y queda en el historial con fecha", () => {
    expect(runner).toContain("kind: ALICLIK_AUTO_FAILED,");
    expect(runner).toContain("payload: { date: today, policy: ALICLIK_AUTO_POLICY, telegram }");
    expect(runner).toContain("sendTelegramToAll(");
  });
});

describe("cuándo corre", () => {
  const cfg = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
  const cron = cfg.crons.find((c) => c.path === "/api/cron/aliclik-scheduled");

  it("cada hora de 8:00 a 13:00 de Lima (UTC−5), antes del corte de Aliclik", () => {
    expect(cron?.schedule).toBe(`7 ${FIRST_PASS_HOUR_LIMA + 5}-${LAST_PASS_HOUR_LIMA + 5} * * *`);
  });

  it("solo en producción, salvo la simulación", () => {
    const route = read("app/api/cron/aliclik-scheduled/route.ts");
    expect(route).toContain('if (!dry && process.env.VERCEL_ENV !== "production")');
    expect(route).toContain("internalAuthorized(req)");
  });
});

describe("se ve", () => {
  it("el hecho tiene nombre en Actividad y en el historial", () => {
    expect(read("components/order-master-shared.tsx")).toContain('aliclik_auto_guide_failed: "Guía automática no creada"');
    expect(read("lib/order-timeline-fact.ts")).toContain('aliclik_auto_guide_failed: consulta("guia")');
  });

  it("quien programa un pedido de provincia sabe que la guía sale sola", () => {
    expect(AUTO_GUIDE_HINT).toContain("crea sola la guía Aliclik");
    expect(AUTO_GUIDE_HINT).toContain("salvo que vaya por Shalom o tenga un pago registrado");
    expect(read("components/dispatch-date-panel.tsx")).toContain("{AUTO_GUIDE_HINT}");
    expect(read("components/order-drawer.tsx")).toContain('classifyOperation(row) === "provincia_cod" && ` ${AUTO_GUIDE_HINT}`');
  });

  it("el MOM lo dice", () => {
    const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
    expect(mom).toContain("#### Guía Aliclik automática el día programado (16-10-2026)");
    expect(mom).toContain("`aliclik_auto_guide_failed`");
  });
});
