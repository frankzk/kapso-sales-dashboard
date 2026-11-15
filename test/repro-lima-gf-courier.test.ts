// GF Courier en los acuerdos de Repro Lima (owner, 15-11-2026: «Sí, haz lo de
// GF Courier en los acuerdos. En el caso de GF Courier la guía ya podría
// quedar generada para esa fecha.»; MOM §9.5 y §29.17). Lo que se fija aquí,
// con reglas puras: qué couriers ofrece la hoja según la tienda, cómo trata
// «Qué hacer con la caja» a GF Courier, la regla de la fecha, qué pasa con la
// guía GF viva, que la guía GF automática respeta el acuerdo, que la Agenda
// conserva el día, que todo dice «GF Courier», y que la migración, el MOM y
// DEPLOY.md dicen lo mismo. Las acciones, con la base simulada, en
// test/repro-lima-actions.test.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agreementDateProblem,
  agreementState,
  agreementStateLabel,
  defaultReproCourier,
  firstAllowedDay,
  GF_COURIER_STORE_ONLY,
  gfAgreementGuideNote,
  gfAgreementGuidePlan,
  gfGuideAssignedMessage,
  GRUPO_GF_NOT_IN_GF_STORE,
  isReproCourier,
  materializationPlan,
  reproAttentionEpisodeKey,
  reproCourierChoices,
  reproCourierName,
  reproCourierStoreProblem,
  reproEventNote,
  reproGfGuideReason,
  REPRO_COURIER_CHOICES,
  REPRO_COURIER_LABEL,
  REPRO_COURIERS,
  REPRO_GF_COURIER_CHOICES,
  type BoxLocation,
} from "@/lib/repro-lima";
import { boxActionReadyLabel, GF_COURIER_READY, reproBoxAction, type ReproBoxActionInput } from "@/lib/repro-box-action";
import { gfAutoReproAgreement, gfAutoReproDetail, type GfAutoReproCase } from "@/lib/gf-auto-guide";
import { nombreDeCourier, sameCourier } from "@/lib/shipment-output";
import { compareDispatchCodes, courierDisplayName, dispatchedWith, dispatchedWithLabel } from "@/lib/dispatched-with";
import { agendaWindow, agendarPath, classifyLimaRow, limaNextStep } from "@/lib/repro-lima-blocks";
import { limaScheduledFor, type LimaPendingOrder } from "@/lib/repro-lima-pending";
import { limaClock } from "@/lib/grupo-gf-courier";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
const flat = (text: string) => text.replace(/\s+/g, " ");

/** Lunes 16-11-2026 en Lima. */
const LUNES = "2026-11-16";
const MARTES = "2026-11-17";
const DOMINGO = "2026-11-15";
const lima = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);

describe("qué couriers ofrece la hoja, según la tienda", () => {
  it("con GF Courier por API: GF Courier primero y por defecto, después Aliclik, Swayp y Axel; sin Grupo GF", () => {
    expect(REPRO_GF_COURIER_CHOICES).toEqual(["gf_courier", "aliclik", "fenix", "axel"]);
    expect(reproCourierChoices(true)).toEqual(["gf_courier", "aliclik", "fenix", "axel"]);
    expect(reproCourierChoices(true)).not.toContain("propio");
    expect(defaultReproCourier(true)).toBe("gf_courier");
  });

  it("sin GF Courier por API: lo de siempre, con Grupo GF por defecto y sin GF Courier", () => {
    expect(reproCourierChoices(false)).toBe(REPRO_COURIER_CHOICES);
    expect(REPRO_COURIER_CHOICES).toEqual(["propio", "aliclik", "fenix", "axel"]);
    expect(defaultReproCourier(false)).toBe("propio");
  });

  it("el servidor lo vuelve a decir: GF Courier solo con la API y Grupo GF nunca con ella", () => {
    expect(reproCourierStoreProblem("gf_courier", false)).toBe(GF_COURIER_STORE_ONLY);
    expect(reproCourierStoreProblem("propio", true)).toBe(GRUPO_GF_NOT_IN_GF_STORE);
    expect(GF_COURIER_STORE_ONLY).toBe("Esta tienda no tiene GF Courier por API: elige Grupo GF u otro courier.");
    expect(GRUPO_GF_NOT_IN_GF_STORE).toBe("Esta tienda despacha por GF Courier (API): Grupo GF ya no toma sus pedidos. Elige GF Courier u otro courier.");
    for (const courier of ["aliclik", "fenix", "axel"] as const) {
      expect(reproCourierStoreProblem(courier, true)).toBeNull();
      expect(reproCourierStoreProblem(courier, false)).toBeNull();
    }
    expect(reproCourierStoreProblem("gf_courier", true)).toBeNull();
    expect(reproCourierStoreProblem("propio", false)).toBeNull();
  });

  it("`gf_courier` es un courier del acuerdo, con el mismo token que la salida", () => {
    expect(REPRO_COURIERS).toContain("gf_courier");
    expect(isReproCourier("gf_courier")).toBe(true);
    expect(sameCourier("gf courier", "gf_courier")).toBe(true);
    expect(sameCourier("gf_courier", "propio")).toBe(false);
  });
});

describe("todo Repro Lima dice «GF Courier»", () => {
  it("el acuerdo, la salida, la chapa, el historial y «Salió con»", () => {
    expect(REPRO_COURIER_LABEL.gf_courier).toBe("GF Courier");
    expect(reproCourierName("gf_courier")).toBe("GF Courier");
    expect(nombreDeCourier("gf_courier")).toBe("GF Courier");
    expect(courierDisplayName("gf_courier")).toBe("GF Courier");
    expect(dispatchedWithLabel("gf_courier")).toBe("GF Courier");
    expect(reproEventNote({ outcome: "confirma", channel: "llamada", agreedOn: LUNES, courier: "gf_courier", boxAction: "salida_nueva_rearmar" }))
      .toBe("Repro Lima · Confirma (llamada): sale el lun 16/11 con GF Courier. Caja: Salida nueva y rearmado. Sin cambios.");
  });

  it("«Salió con»: GF Courier no es un motorizado de Grupo GF ni esconde la salida propia sin parada", () => {
    expect([...["gf_courier", "aliclik", "gf:Roy", "gf"]].sort(compareDispatchCodes)).toEqual(["gf", "gf:Roy", "aliclik", "gf_courier"]);
    const out = dispatchedWith({
      guides: [
        { id: "g1", courier: "gf_courier", delivery_status: "en_ruta" },
        { id: "p1", courier: "propio", delivery_status: "entregado", dispatched_at: "2026-11-10T15:00:00Z" },
      ],
      stops: [],
      events: [],
      urpiAttempts: 0,
    });
    expect(out).toEqual(["gf", "gf_courier"]);
  });

  it("el estado del acuerdo con la guía GF ya creada: «Salida creada · sale … con GF Courier»", () => {
    const box: BoxLocation = { kind: "con_courier", courier: "gf_courier", enOficina: false };
    const c = { agreed_on: LUNES, agreed_courier: "gf_courier", box_action: "salida_nueva_rearmar", materialized_at: null, materialized_on: null };
    const state = agreementState({ c, program: null, box, plan: { no: "otro_courier" }, today: DOMINGO });
    expect(state).toEqual({ kind: "salida_creada" });
    expect(agreementStateLabel(state, c, box, DOMINGO)).toBe("Salida creada · sale lun 16/11 con GF Courier");
    // Sin guía (GF no la creó): se crea en la Mesa de ruta, como otro courier.
    const none = agreementState({ c, program: null, box: { kind: "desconocida" }, plan: { no: "otro_courier" }, today: DOMINGO });
    expect(agreementStateLabel(none, c, { kind: "desconocida" }, DOMINGO)).toBe("Sale lun 16/11 con GF Courier · crea la salida en la Mesa de ruta");
  });
});

describe("«Qué hacer con la caja» con GF Courier: como Aliclik en Lima, otro courier con su propia guía", () => {
  const base = (over: Partial<ReproBoxActionInput> = {}): ReproBoxActionInput => ({
    outcome: "confirma",
    courier: "gf_courier",
    changes: {},
    box: { kind: "desconocida" },
    ownLiveCourier: null,
    lastFailedCourier: null,
    otherLiveCourier: null,
    hadPropio: false,
    totalOutputs: 1,
    priorWithCourier: 1,
    ...over,
  });

  it("las mismas reglas que Aliclik: salida nueva, desarmar y rearmar o caja nueva desde stock", () => {
    for (const courier of ["gf_courier", "aliclik"] as const) {
      expect(reproBoxAction(base({ courier }))).toMatchObject({ action: "salida_nueva_rearmar", newSalida: true });
      expect(reproBoxAction(base({ courier, changes: { producto: true } }))).toMatchObject({ action: "desarmar_rearmar" });
      const rider: BoxLocation = { kind: "con_motorizado", riderName: "Roy", since: "2026-11-14" };
      expect(reproBoxAction(base({ courier, box: rider, changes: { no_esperar_caja: true } }))).toMatchObject({ action: "caja_nueva_stock" });
    }
  });

  it("la etiqueta dice que Kapta crea la guía al guardar, para el día acordado; no manda a la Mesa de ruta", () => {
    const r = reproBoxAction(base());
    expect("label" in r && r.label).toBe("Salida nueva de GF Courier: guía de GF Courier, que Kapta crea al guardar para el día acordado (GF prepara el paquete).");
    const first = reproBoxAction(base({ totalOutputs: 0, priorWithCourier: 0 }));
    expect("label" in first && first.label).toContain("Primera salida de GF Courier: guía de GF Courier, que Kapta crea al guardar");
    const product = reproBoxAction(base({ changes: { producto: true } }));
    expect("label" in product && product.label).toContain("con el producto de ahora");
    expect("label" in product && product.label).not.toContain("Mesa de ruta");
  });

  it("sin tope de salidas ni límite de repetición (§29.17)", () => {
    expect(reproBoxAction(base({ totalOutputs: 7, priorWithCourier: 6 }))).toMatchObject({ action: "salida_nueva_rearmar" });
    expect(reproBoxAction(base({ courier: "aliclik", totalOutputs: 5, priorWithCourier: 1 }))).toEqual({ problem: "Ya usó las 5 salidas: solo queda «Desarmar y cerrar»." });
  });

  it("la guía GF viva no bloquea un acuerdo con GF Courier (Kapta la reemplaza); sí bloquea a los demás, y la de otro courier bloquea a GF Courier", () => {
    const gfLive: Partial<ReproBoxActionInput> = { otherLiveCourier: "gf_courier", box: { kind: "con_courier", courier: "gf_courier", enOficina: false } };
    expect(reproBoxAction(base(gfLive))).toMatchObject({ action: "salida_nueva_rearmar" });
    expect(reproBoxAction(base({ ...gfLive, courier: "aliclik" }))).toEqual({ problem: "La guía de GF Courier sigue viva: la trabaja ese courier. Revísala en la ficha." });
    expect(reproBoxAction(base({ otherLiveCourier: "aliclik" }))).toEqual({ problem: "La guía de Aliclik sigue viva: la trabaja ese courier. Revísala en la ficha." });
  });

  it("nunca se programa en Grupo GF: `otro_courier`, como Aliclik", () => {
    for (const box of [{ kind: "en_oficina", since: null, courier: "propio" }, { kind: "desconocida" }, { kind: "con_courier", courier: "gf_courier", enOficina: false }] as BoxLocation[]) {
      expect(materializationPlan({ courier: "gf_courier", boxAction: "salida_nueva_rearmar", box, retryAdmission: true })).toEqual({ no: "otro_courier" });
      expect(materializationPlan({ courier: "gf_courier", boxAction: "caja_nueva_stock", box, retryAdmission: true })).toEqual({ no: "otro_courier" });
    }
  });

  it("«Lista para»: desde hoy, GF prepara el paquete (sin corte ni noche anterior)", () => {
    for (const action of ["mantener", "reimprimir_misma_salida", "salida_nueva_rearmar", "desarmar_rearmar", "caja_nueva_stock"] as const) {
      expect(boxActionReadyLabel(action, "gf_courier", "12:00")).toBe(GF_COURIER_READY);
    }
    expect(boxActionReadyLabel("salida_nueva_rearmar", "aliclik", "12:00")).toBe("Lista desde mañana: se prepara la noche anterior.");
    // Almacén tampoco pide «prepárala la noche anterior» para un acuerdo con GF Courier.
    expect(read("lib/warehouse-retries.ts")).toContain('const gfPrepares = Boolean(agreement && sameCourier(agreement.courier, "gf_courier"));');
  });
});

describe("la fecha del acuerdo con GF Courier: sin el corte de Grupo GF; un día pasado no vale", () => {
  const after = limaClock(lima(LUNES, "13:30")).minute;
  const check = (over: Partial<Parameters<typeof agreementDateProblem>[0]>) =>
    agreementDateProblem({ day: LUNES, today: LUNES, nowMinute: after, cutoff: "12:00:00", courier: "gf_courier", boxAction: "salida_nueva_rearmar", ...over });

  it("hoy después del corte, también con una acción de la noche anterior", () => {
    expect(check({})).toBeNull();
    expect(check({ boxAction: "desarmar_rearmar" })).toBeNull();
    expect(check({ day: MARTES })).toBeNull();
    expect(firstAllowedDay("gf_courier", "12:00", lima(LUNES, "13:30"), "salida_nueva_rearmar")).toBe(LUNES);
  });

  it("un día que ya pasó, o más allá de los 60 días, no", () => {
    expect(check({ day: DOMINGO })).toBe("La nueva fecha no puede ser anterior a hoy.");
    expect(check({ day: "2027-02-01" })).toMatch(/60 días/);
  });

  it("Grupo GF y Aliclik siguen con sus reglas", () => {
    expect(check({ courier: "propio", boxAction: "mantener" })).toMatch(/^Pasó el corte de las 12:00/);
    expect(check({ courier: "aliclik" })).toBe("«Salida nueva y rearmado» se prepara la noche anterior: elige desde mañana.");
    expect(firstAllowedDay("aliclik", "12:00", lima(LUNES, "09:00"), "salida_nueva_rearmar")).toBe(MARTES);
  });
});

describe("la guía GF viva al guardar o mover un acuerdo con GF Courier", () => {
  const guide = (delivery_status: string, over: Record<string, unknown> = {}) => ({ courier: "gf_courier", delivery_status, guide_code: "GF1", returned_at: null, created_at: "2026-11-14T15:00:00Z", ...over });

  it("sin guía GF viva, se crea; la anulada, entregada o devuelta no cuenta", () => {
    expect(gfAgreementGuidePlan([])).toEqual({ kind: "crear" });
    expect(gfAgreementGuidePlan([guide("anulado"), guide("entregado"), guide("en_ruta", { returned_at: "2026-11-14T20:00:00Z" })])).toEqual({ kind: "crear" });
    // Otra salida viva (Aliclik) no es una guía GF.
    expect(gfAgreementGuidePlan([{ courier: "aliclik", delivery_status: "pendiente", guide_code: "AL1" }])).toEqual({ kind: "crear" });
  });

  it("sin asignar (`pendiente`): se anula primero y se crea la del día; asignada (`en_ruta`): no se crea otra", () => {
    expect(gfAgreementGuidePlan([guide("pendiente")])).toEqual({ kind: "reemplazar", cancel: [{ guideCode: "GF1" }] });
    expect(gfAgreementGuidePlan([guide("pendiente"), guide("en_ruta", { guide_code: "GF2" })])).toEqual({ kind: "asignada", guideCode: "GF2" });
  });

  it("la guía que nació después de acordar es la del acuerdo: un reintento no la reemplaza", () => {
    expect(gfAgreementGuidePlan([guide("pendiente", { created_at: "2026-11-15T15:00:01Z" })], "2026-11-15T15:00:00Z")).toEqual({ kind: "lista", guideCode: "GF1" });
    expect(gfAgreementGuidePlan([guide("pendiente")], "2026-11-15T15:00:00Z")).toEqual({ kind: "reemplazar", cancel: [{ guideCode: "GF1" }] });
  });

  it("lo que dice la hoja antes de guardar y el motivo de la guía", () => {
    expect(gfAgreementGuideNote({ kind: "crear" })).toBeNull();
    expect(gfAgreementGuideNote({ kind: "reemplazar", cancel: [{ guideCode: "GF1" }] })).toBe("Al guardar, Kapta anula la guía GF1 (GF todavía no la asigna a un motorizado) y crea otra para el día acordado.");
    expect(gfAgreementGuideNote({ kind: "asignada", guideCode: "GF1" })).toBe(gfGuideAssignedMessage("GF1"));
    expect(gfGuideAssignedMessage("GF1")).toBe("GF Courier ya asignó la guía GF1 a un motorizado (en ruta): no se crea otra. Sale con esa si GF la reprograma; si GF la devuelve o la anula, se crea la siguiente.");
    expect(reproGfGuideReason(LUNES)).toBe("Repro Lima: acuerdo con la clienta para el lun 16/11");
  });
});

describe("la guía GF automática respeta el acuerdo de Repro Lima", () => {
  const open = (over: Partial<GfAutoReproCase> = {}): GfAutoReproCase => ({
    order_id: "o1", episode_key: reproAttentionEpisodeKey("o1"), agreed_on: MARTES, agreed_courier: "aliclik", closed_at: null, ...over,
  });

  it("un caso abierto con día acordado en su episodio vigente: la pasada no lo toma, sea cual sea el courier", () => {
    expect(gfAutoReproAgreement("o1", [open()])).toEqual(open());
    expect(gfAutoReproAgreement("o1", [open({ agreed_courier: "gf_courier", agreed_on: DOMINGO })])).not.toBeNull();
    expect(gfAutoReproDetail(open())).toBe("Tiene un acuerdo en Repro Lima: sale el mar 17/11 con Aliclik. El acuerdo decide el día y el courier.");
    expect(gfAutoReproDetail(open({ agreed_courier: "gf_courier" }))).toContain("con GF Courier");
  });

  it("sin acuerdo, cerrado, de otro episodio o de otro pedido: la pasada sigue como antes", () => {
    expect(gfAutoReproAgreement("o1", [])).toBeNull();
    expect(gfAutoReproAgreement("o1", [open({ agreed_on: null })])).toBeNull();
    expect(gfAutoReproAgreement("o1", [open({ closed_at: "2026-11-15T15:00:00Z" })])).toBeNull();
    expect(gfAutoReproAgreement("o1", [open({ episode_key: "s:stop-1|o:-" })])).toBeNull();
    expect(gfAutoReproAgreement("o2", [open()])).toBeNull();
  });

  it("la pasada lo mira con los acompañantes, antes de mirar guías, simular o crear; lo dice en su informe y no avisa", () => {
    const runner = read("lib/gf-auto-guide-server.ts");
    const fn = runner.slice(runner.indexOf("export async function runGfAutoGuides("), runner.indexOf("// ── El panel"));
    expect(fn).toContain('admin.from("lima_repro_cases").select("order_id,episode_key,agreed_on,agreed_courier,closed_at").in("order_id", chunk).is("closed_at", null)');
    const skip = fn.indexOf("const agreement = gfAutoReproAgreement(row.order_id, reproCases);");
    expect(skip).toBeGreaterThan(fn.indexOf("if (companions.has(row.order_id))"));
    for (const later of ["activeAliclikBlocker(admin, row.order_id)", "previewGfGuide(admin, row", "createGfGuideFor(row.order_id"]) {
      expect(skip, later).toBeLessThan(fn.indexOf(later));
    }
    const branch = fn.slice(skip, fn.indexOf("continue;", skip));
    expect(branch).toContain('item.outcome = "acuerdo_repro_lima";');
    expect(branch).toContain("item.detail = gfAutoReproDetail(agreement);");
    expect(branch).not.toContain("fail(");
    expect(runner).toContain('export type GfAutoItemOutcome = GfAutoOutcome | "ya_intentado" | "acompanante" | "acuerdo_repro_lima" | "ya_tiene_guia" | "error";');
    // Sin poder leer los casos no se crea nada.
    expect(fn).toContain("No se pudo verificar qué pedidos ya se intentaron hoy o viajan en la caja de otro (ni sus acuerdos de Repro Lima)");
  });

  it("el episodio de atención es el mismo que usa Repro Lima al leer", () => {
    expect(reproAttentionEpisodeKey("o1")).toBe("attention:o1");
    expect(read("lib/repro-lima-program.ts")).toContain("? { key: reproAttentionEpisodeKey(orderId), at: null }");
  });
});

describe("la Agenda conserva el día de un acuerdo con GF Courier y su guía", () => {
  const TODAY = DOMINGO;
  const WINDOW = agendaWindow(TODAY);
  const row = (over: Partial<LimaPendingOrder> = {}): LimaPendingOrder => ({
    orderId: "o1", storeId: "a", storeName: "Aurela", orderName: "#AUR1", customerName: "Ana", customerPhone: "51987654321",
    district: "Surco", orderTotal: 149, createdAt: "2026-11-10T15:00:00Z", macroSince: "2026-11-14T15:00:00Z",
    stage: "por_despachar", substage: "listo_para_recojo", courier: "gf_courier", dispatchedAt: null, attempts: 1,
    hasPriorDispatch: true, lastDepartureAt: "2026-11-12T15:00:00Z", programmedFor: null, salesChannel: null, address: "Av. Benavides 123", reference: null,
    courierPickup: null, gf: null, scheduledOn: null, ops: { liveCouriers: ["gf_courier"], reportedStatus: "CREATED", courierDelivered: null, lastGfBox: null }, ...over,
  });

  it("con el caso abierto: el día acordado, «Acordado con la clienta · GF Courier»", () => {
    const c = { orderId: "o1", list: "programados" as const, agreement: { agreedOn: MARTES, courier: "gf_courier", courierName: "GF Courier" } };
    expect(limaScheduledFor(row(), c)).toBe(MARTES);
    expect(classifyLimaRow(row(), c, TODAY, WINDOW)).toMatchObject({ step: "con_courier", guide: true, agenda: "despues", agendaDay: MARTES, agendaOrigin: "acuerdo", courier: "guia_creada", agreed: true });
    expect(agendarPath(row(), c, { canScheduleDispatch: true })).toMatchObject({ kind: "acuerdo", current: MARTES, courierName: "GF Courier" });
  });

  it("con el caso ya cerrado (el pedido dejó «Por reprogramar Lima»): el día que se le pidió a GF", () => {
    const r = row({ courierPickup: { courier: "gf_courier", date: MARTES } });
    expect(limaScheduledFor(r)).toBe(MARTES);
    const cls = classifyLimaRow(r, undefined, TODAY, WINDOW);
    expect(cls).toMatchObject({ step: "con_courier", guide: true, agenda: "despues", agendaDay: MARTES, agendaOrigin: "recojo", courier: "guia_creada" });
    expect(limaNextStep(r, undefined, cls, TODAY, lima(TODAY, "10:00"))).toBe("Lo recoge GF Courier el mar 17/11.");
  });
});

describe("la migración 0347, el MOM y DEPLOY.md", () => {
  it("0347 amplía los dos CHECK con `gf_courier`, como la 0283 con Aliclik, y se puede correr otra vez", () => {
    const sql = read("db/migrations/0347_lima_repro_gf_courier.sql");
    const list = "('propio', 'gf_courier', 'aliclik', 'tanders', 'fenix', 'urpi', 'axel')";
    expect(sql).toContain("drop constraint if exists lima_repro_cases_agreed_courier_check;");
    expect(sql).toContain(`check (agreed_courier in ${list});`);
    expect(sql).toContain("drop constraint if exists lima_repro_calls_courier_check;");
    expect(sql).toContain(`check (courier in ${list});`);
    expect(sql).not.toMatch(/\b(update|delete|truncate|drop table)\b/i);
    expect(read("db/apply.sql")).toContain("\\ir migrations/0347_lima_repro_gf_courier.sql");
    // Los mismos couriers que el tipo.
    for (const c of REPRO_COURIERS) expect(list).toContain(`'${c}'`);
  });

  it("el MOM lo documenta en §9.5 y en §29.17, con la decisión del owner", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    const s95 = flat(mom.slice(mom.indexOf("### 9.5 Reprogramación en Lima"), mom.indexOf("### 9.6 ")));
    const s2917 = flat(mom.slice(mom.indexOf("### 29.17 GF Courier por API"), mom.indexOf("## 30. ")));
    const quote = "«Sí, haz lo de GF Courier en los acuerdos. En el caso de GF Courier la guía ya podría quedar generada para esa fecha.»";
    expect(s95).toContain(quote);
    expect(s95).toContain("15-11-2026");
    for (const piece of ["`reproCourierChoices`", "`createGfGuideFor`", "`cancelGfGuideFor`", "«Nuevo acuerdo en Repro Lima»", "`moveReproAgreement`", "0347"]) {
      expect(s95, piece).toContain(piece);
    }
    expect(s2917).toContain(quote);
    expect(s2917).toContain("`acuerdo_repro_lima`");
    expect(s2917).toContain("`scheduledFor`");
  });

  it("DEPLOY.md: la entrada de la 0347 va justo después de la de 0345 y 0346, ya aplicada y antes del código", () => {
    const deploy = read("DEPLOY.md");
    const starts = [...deploy.matchAll(/^### /gm)].map((m) => m.index!);
    const entry = (i: number) => deploy.slice(starts[i]!, starts[i + 1]);
    expect(entry(0)).toContain("0344_gf_courier_api");
    expect(entry(1)).toContain("0345_gf_auto_guide.sql");
    const third = flat(entry(2));
    expect(third).toContain("0347");
    expect(third).toContain("Migración 0347: ya aplicada en producción (15-11-2026), antes del código");
    expect(third).toContain("Verificar");
  });
});
