import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LIMA_COURIER_AUTO_FAILED,
  LIMA_COURIER_AUTO_CRON,
  LIMA_COURIER_AUTO_PASS_HOURS_LIMA,
  limaAliclikPickupFits,
  isLimaCourierAutoOutcome,
  limaCourierAutoActivoBlocker,
  limaCourierAutoModeFrom,
  limaCourierAutoOutcomeLabel,
  limaCourierAutoPassOpen,
  limaCourierCaseCourier,
  limaCourierEnvioCourier,
  limaCourierFailedNote,
  limaCourierFailureTelegram,
  limaCourierMotive,
  limaCourierReason,
  limaCourierServes,
  limaCourierTargetDay,
  limaCourierTriedOn,
  type LimaCourierCase,
  type LimaCourierEnvioRow,
} from "@/lib/lima-courier-auto";
import { MOTIVE_ORIGIN_KINDS, aliclikMotiveAllowed } from "@/lib/aliclik-output-policy";
import { guideCreatorPhrase } from "@/lib/guide-note";
import { AUTOMATIONS, LIMA_COURIER_AUTO_KEY, ORG_AUTOMATION_TABLES, ORG_TABLE_SHAPE, needsConfirmation } from "@/lib/automations-catalog";
import { limaAutoGuideBy, programCourierHint, programCourierProblem } from "@/lib/repro-lima-blocks";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) => text.replace(/\s+/g, " ");

const MON = "2026-11-16"; // lunes
const SAT = "2026-11-21";

const envio = (over: Partial<LimaCourierEnvioRow> = {}): LimaCourierEnvioRow => ({
  dispatch_scheduled_on: MON,
  dispatch_courier: "aliclik",
  macro_stage: "preparacion",
  macro_substage: "por_generar_rotulo",
  shipping_mode: "cod",
  coverage: "lima",
  region: "Lima",
  province: "Lima",
  district: "Miraflores",
  ...over,
});

const acuerdo = (over: Partial<LimaCourierCase> = {}): LimaCourierCase => ({
  id: "c1",
  order_id: "o1",
  agreed_on: MON,
  agreed_courier: "aliclik",
  agreement_call_id: "call1",
  closed_at: null,
  ...over,
});

describe("el día y la hora de cada courier (owner, 16-11-2026: «Kapta la crea ese día»)", () => {
  it("Aliclik: en la mañana, hoy; desde las 15:00, el próximo día. Swayp: la víspera de su próximo día (sin domingos)", () => {
    expect(limaCourierTargetDay("aliclik", MON, 8)).toBe(MON);
    expect(limaCourierTargetDay("aliclik", MON, 12)).toBe(MON);
    expect(limaCourierTargetDay("aliclik", MON, 18)).toBe("2026-11-17");
    expect(limaCourierTargetDay("aliclik", SAT, 20)).toBe("2026-11-23"); // el sábado en la noche, el lunes
    expect(limaCourierTargetDay("fenix", MON, 8)).toBe("2026-11-17");
    expect(limaCourierTargetDay("fenix", "2026-11-20", 21)).toBe(SAT); // el viernes, el sábado
    expect(limaCourierTargetDay("fenix", SAT, 10)).toBe("2026-11-23"); // el sábado, el lunes
    expect(limaCourierTargetDay("fenix", "2026-11-22", 10)).toBe("2026-11-23"); // el domingo, el lunes
  });
  it("las pasadas: 8, 10 y 12 (Aliclik de hoy) y 15, 18, 20 y 21 (owner: «también debe intentar en la noche»)", () => {
    expect(LIMA_COURIER_AUTO_PASS_HOURS_LIMA).toEqual([8, 10, 12, 15, 18, 20, 21]);
    expect(LIMA_COURIER_AUTO_CRON).toBe("12 13,15,17,20,23,1,2 * * *");
    expect(limaCourierAutoPassOpen(7)).toBe(false);
    expect(limaCourierAutoPassOpen(21)).toBe(true);
    expect(limaCourierAutoPassOpen(22)).toBe(false);
    expect(limaCourierServes("aliclik", 12)).toBe(true);
    expect(limaCourierServes("aliclik", 13)).toBe(false);
    expect(limaCourierServes("aliclik", 18)).toBe(true);
    expect(limaCourierServes("fenix", 21)).toBe(true);
    expect(limaCourierServes("fenix", 7)).toBe(false);
  });
  it("lo de mañana con Aliclik, solo si Aliclik lo recoge ese día", () => {
    expect(limaAliclikPickupFits(MON, MON, "2026-11-17")).toBe(true); // lo de hoy se crea igual
    expect(limaAliclikPickupFits("2026-11-17", MON, "2026-11-17")).toBe(true);
    expect(limaAliclikPickupFits("2026-11-17", MON, MON)).toBe(false); // antes del corte la recogería hoy
  });
});

describe("qué pedido entra", () => {
  it("«Programar envío» con courier (0348): Lima, por generar rótulo, Aliclik de hoy o Swayp de mañana", () => {
    expect(limaCourierEnvioCourier(envio(), MON, 8)).toBe("aliclik");
    expect(limaCourierEnvioCourier(envio({ dispatch_scheduled_on: "2026-11-17" }), MON, 8)).toBeNull();
    expect(limaCourierEnvioCourier(envio({ dispatch_scheduled_on: "2026-11-17" }), MON, 20)).toBe("aliclik");
    expect(limaCourierEnvioCourier(envio({ dispatch_courier: "fenix", dispatch_scheduled_on: "2026-11-17" }), MON, 8)).toBe("fenix");
    expect(limaCourierEnvioCourier(envio({ dispatch_courier: "fenix" }), MON, 8)).toBeNull();
    // GF Courier y Grupo GF no son de esta pasada; sin courier, tampoco.
    expect(limaCourierEnvioCourier(envio({ dispatch_courier: "gf_courier" }), MON, 8)).toBeNull();
    expect(limaCourierEnvioCourier(envio({ dispatch_courier: "propio" }), MON, 8)).toBeNull();
    expect(limaCourierEnvioCourier(envio({ dispatch_courier: null }), MON, 8)).toBeNull();
    expect(limaCourierEnvioCourier(envio({ macro_substage: "por_armar" }), MON, 8)).toBeNull();
    expect(limaCourierEnvioCourier(envio({ coverage: "provincia_cod", region: "Arequipa", province: "Arequipa", district: "Cayma" }), MON, 8)).toBeNull();
  });
  it("el acuerdo de Repro Lima vigente con Aliclik o Swayp para ese día", () => {
    expect(limaCourierCaseCourier(acuerdo(), MON, 8)).toBe("aliclik");
    expect(limaCourierCaseCourier(acuerdo({ agreed_courier: "fenix", agreed_on: "2026-11-17" }), MON, 8)).toBe("fenix");
    expect(limaCourierCaseCourier(acuerdo({ agreed_courier: "propio" }), MON, 8)).toBeNull();
    expect(limaCourierCaseCourier(acuerdo({ closed_at: "2026-11-16T10:00:00Z" }), MON, 8)).toBeNull();
    expect(limaCourierCaseCourier(acuerdo({ agreement_call_id: null }), MON, 8)).toBeNull();
    expect(limaCourierCaseCourier(acuerdo({ agreed_on: "2026-11-18" }), MON, 8)).toBeNull();
  });
  it("un intento por pedido y día", () => {
    expect(limaCourierTriedOn([{ kind: LIMA_COURIER_AUTO_FAILED, payload: { date: MON } }], MON)).toBe(true);
    expect(limaCourierTriedOn([{ kind: LIMA_COURIER_AUTO_FAILED, payload: { date: "2026-11-15" } }], MON)).toBe(false);
    expect(limaCourierTriedOn([{ kind: "gf_auto_guide_failed", payload: { date: MON } }], MON)).toBe(false);
  });
});

describe("lo que dice", () => {
  it("motivo, historial, alerta y posición", () => {
    expect(limaCourierReason("aliclik", MON, "acuerdo")).toBe("Guía Aliclik automática del lun 16/11 (acuerdo de Repro Lima).");
    expect(limaCourierMotive("fenix", "2026-11-17", "acuerdo")).toBe("Acuerdo de Repro Lima: sale el mar 17/11 con Swayp (guía automática del día programado).");
    expect(limaCourierFailedNote("aliclik", MON)).toContain("créala a mano desde la Mesa de ruta");
    const tg = limaCourierFailureTelegram({ storeName: "Kenku", orderName: "#KP1", customerName: "Ana", district: "Surco", courier: "aliclik", day: MON, error: "Falta la ubicación", url: "https://x/y" });
    expect(tg).toContain("Guía Aliclik automática no creada");
    expect(tg).toContain("Falta la ubicación");
    expect(limaCourierAutoModeFrom("activo")).toBe("activo");
    expect(limaCourierAutoModeFrom("raro")).toBe("apagado");
    expect(isLimaCourierAutoOutcome("creada")).toBe(true);
    expect(limaCourierAutoOutcomeLabel("fallo", "simulacion")).toBe("No la crearía");
    expect(limaCourierAutoActivoBlocker({ aliclikWrite: false, swaypEnabled: false })).toContain("apagados en el servidor");
    expect(limaCourierAutoActivoBlocker({ aliclikWrite: true, swaypEnabled: false })).toBeNull();
  });
  it("el automático del día programado puede justificar otra salida en Lima, con su motivo", () => {
    expect(MOTIVE_ORIGIN_KINDS).toContain("dia_programado_lima");
    expect(aliclikMotiveAllowed(null, "dia_programado_lima")).toBe(true);
    expect(aliclikMotiveAllowed(null, "envio_programado")).toBe(false);
    expect(guideCreatorPhrase(null, "dia_programado_lima")).toBe("automáticamente (día programado en Lima)");
  });
});

describe("Repro Lima lo dice al programar (0349)", () => {
  it("Swayp desde mañana y sin domingo; Aliclik con la ubicación", () => {
    expect(programCourierProblem("fenix", MON, MON, true)).toBe("Swayp arma su ruta el día anterior: elige desde mañana.");
    expect(programCourierProblem("fenix", "2026-11-22", MON, true)).toContain("domingos");
    expect(programCourierProblem("fenix", "2026-11-17", MON, false)).toBeNull();
    expect(programCourierProblem("aliclik", MON, MON, false)).toContain("ubicación");
    expect(programCourierProblem("aliclik", MON, MON, true)).toBeNull();
    expect(programCourierProblem("propio", MON, MON, false)).toBeNull();
  });
  it("con la automática en Activo, dice que Kapta crea la guía", () => {
    expect(programCourierHint("aliclik", true)).toContain("Kapta crea su guía la noche anterior o la mañana de ese día");
    expect(programCourierHint("aliclik", false)).toContain("«Guía Aliclik»");
    expect(programCourierHint("fenix", true)).toContain("la víspera");
    expect(programCourierHint("gf_courier", true)).toBe("GF Courier: la guía queda creada para ese día.");
  });
  it("quién crea sola la guía de la fila", () => {
    const row = (over: Partial<LimaPendingOrder>) => ({ orderId: "o", storeId: "s1", stage: "preparacion", substage: "por_generar_rotulo", ...over }) as LimaPendingOrder;
    const both = { autoGuideStores: new Set(["s1"]), courierAutoStores: new Set(["s1"]) };
    expect(limaAutoGuideBy(row({ scheduledCourier: "aliclik" }), undefined, both)).toBe("aliclik");
    expect(limaAutoGuideBy(row({ scheduledCourier: "aliclik" }), undefined, { autoGuideStores: new Set(["s1"]) })).toBeNull();
    expect(limaAutoGuideBy(row({ scheduledCourier: null }), undefined, both)).toBe("gf_courier");
    const agreed = { agreement: { agreedOn: "2026-11-17", courier: "fenix" } } as never;
    expect(limaAutoGuideBy(row({ stage: "en_curso", substage: "por_reprogramar_lima" }), agreed, both)).toBe("fenix");
    expect(limaAutoGuideBy(row({}), { agreement: { agreedOn: "2026-11-17", courier: "propio" } } as never, both)).toBeNull();
  });
});

describe("las guardas, en el código", () => {
  const server = flat(read("lib/lima-courier-auto-server.ts"));
  const route = read("app/api/cron/lima-courier-auto/route.ts");
  it("crea por los mismos caminos que las personas, sin actor y con su origen", () => {
    expect(server).toContain('import "server-only";');
    expect(server).toContain('const origin: AliclikGuideOrigin = { kind: "dia_programado_lima", scheduledOn: c.day, reason };');
    expect(server).toContain("await createAliclikGuideFor(ctx, createInput, resolved.scope, origin)");
    expect(server).toContain("const gates = await aliclikCreateGates(ctx, createInput, resolved.scope, origin);");
    expect(server).toContain("const transportId = defaultAliclikTransport(preview.couriers);");
    expect(server).toContain("await emitirGuiaSwaypDirecta(admin, { order: order as unknown as DirectGuideOrderRecord, actorId: null, dispatchDateIso: `${c.day}T00:00:00.000Z`,");
    // Solo el acuerdo vigente de su episodio.
    expect(server).toContain("if (!f.open || f.open.id !== c.id || f.open.episode_key !== f.episode.key) continue;");
    // En Simulación no avisa ni deja hecho.
    expect(server).toContain("if (!simulate) { report.failed += 1; item.telegram = await recordFailure(");
  });
  it("el cron: CRON_SECRET, `?dry=1` sin escribir y solo producción crea", () => {
    expect(route).toContain("if (!internalAuthorized(req))");
    expect(route).toContain('if (!dry && process.env.VERCEL_ENV !== "production")');
    const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons.find((c) => c.path === "/api/cron/lima-courier-auto")?.schedule).toBe(LIMA_COURIER_AUTO_CRON);
  });
  it("Automatizaciones: Apagado / Simulación / Activo por organización, con su tabla y confirmación", () => {
    const entry = AUTOMATIONS.find((a) => a.key === LIMA_COURIER_AUTO_KEY)!;
    expect(entry.group).toBe("logistica_lima");
    expect(entry.control).toEqual({ kind: "org_mode", table: "lima_courier_auto_settings", column: "mode" });
    expect(needsConfirmation(entry)).toBe(true);
    expect(ORG_AUTOMATION_TABLES).toContain("lima_courier_auto_settings");
    expect(ORG_TABLE_SHAPE.lima_courier_auto_settings).toEqual({ columns: ["mode"], updatedBy: true });
    const actions = read("app/dashboard/automatizaciones/actions.ts");
    expect(actions).toContain("export async function setLimaCourierAutoMode(orgId: string, mode: string)");
  });
  it("la 0349: aditiva, con RLS de lectura y nace Apagado", () => {
    const sql = read("db/migrations/0349_lima_courier_auto.sql");
    expect(sql).toContain("create table if not exists public.lima_courier_auto_settings");
    expect(sql).toContain("mode        text not null default 'apagado'");
    expect(sql).toContain("check (courier in ('aliclik', 'fenix'))");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("revoke all on public.lima_courier_auto_settings, public.lima_courier_auto_log from anon, authenticated;");
    expect(sql).not.toMatch(/drop\s+(table|column)/i);
  });
});
