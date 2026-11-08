// La guía Shalom muerta y la que la reemplaza (MOM §12, 08-11-2026; 0321).
// #KP201035: Kapta tiene la guía 102321353 (HWND, creada por API el 01-11) y el
// rastreo contesta `not_found`; en Shalom Pro está la 102371814 (W9NH, creada a
// mano el 04-11, «En destino») para la misma clienta, DNI 41059706, y en Kapta
// no está en ningún sitio. La caja salió con esa.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deadGuideListingConflict,
  guideInCandidateWindow,
  matchShalomListing,
  type CotejoShalomOrder,
  type ShalomListingGuide,
} from "@/lib/shalom/account-match";
import {
  deadGuideCancelNote,
  deadGuideRestorePatch,
  deadGuideRetirePatch,
  isConfirmedDeadShalomGuide,
  planDeadGuideReplacement,
  type DeadGuideCandidate,
  type DeadGuideRow,
} from "@/lib/shalom/dead-guide";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
const flat = (text: string) => text.replace(/\s+/g, " ");
const NOW = Date.parse("2026-11-08T15:00:00.000Z");
const AMBOS = { documento: true, telefono: true };

const MUERTA: DeadGuideCandidate = {
  id: "ship-dead",
  courier: "shalom",
  guide_code: "102321353",
  delivery_status: "pendiente",
  created_via: "shalom_pro_api",
  custody_state: "empresa",
  custody_transferred_at: null,
  shalom_not_found_since: "2026-11-03T21:30:00.000Z",
  shalom_not_found_count: 40,
};

describe("cuándo una guía viva cuenta como muerta", () => {
  it("Shalom, viva y con la racha de «no reconocida» (6 consultas y 24 h)", () => {
    expect(isConfirmedDeadShalomGuide(MUERTA, NOW)).toBe(true);
  });

  it("no con la racha corta, ni de otro courier, ni cerrada, ni la salida «por definir»", () => {
    expect(isConfirmedDeadShalomGuide({ ...MUERTA, shalom_not_found_count: 5 }, NOW)).toBe(false);
    expect(isConfirmedDeadShalomGuide({ ...MUERTA, shalom_not_found_since: "2026-11-08T10:00:00.000Z" }, NOW)).toBe(false);
    expect(isConfirmedDeadShalomGuide({ ...MUERTA, courier: "olva" }, NOW)).toBe(false);
    expect(isConfirmedDeadShalomGuide({ ...MUERTA, delivery_status: "anulado" }, NOW)).toBe(false);
    expect(isConfirmedDeadShalomGuide({ ...MUERTA, delivery_status: "entregado" }, NOW)).toBe(false);
    expect(
      isConfirmedDeadShalomGuide({ ...MUERTA, courier: "por_definir", created_via: "manual_route" }, NOW),
    ).toBe(false);
    expect(isConfirmedDeadShalomGuide({ ...MUERTA, shalom_not_found_count: 0, shalom_not_found_since: null }, NOW)).toBe(false);
  });
});

describe("qué hacer con las salidas vivas al registrar la guía nueva", () => {
  const viva: DeadGuideCandidate = { ...MUERTA, id: "ship-live", guide_code: "999", shalom_not_found_count: 0, shalom_not_found_since: null };

  it("la muerta se retira si quien llama lo pide", () => {
    expect(planDeadGuideReplacement([MUERTA], "102371814", { replaceDead: true, now: NOW })).toEqual({ retire: [MUERTA], blocking: null });
  });

  it("sin pedirlo, la muerta bloquea como cualquier salida viva", () => {
    expect(planDeadGuideReplacement([MUERTA], "102371814", { replaceDead: false, now: NOW })).toEqual({ retire: [], blocking: MUERTA });
  });

  it("con `only`, solo esa: el cron reemplaza la guía que cotejó", () => {
    expect(planDeadGuideReplacement([MUERTA], "102371814", { replaceDead: true, only: "otra", now: NOW })).toEqual({
      retire: [],
      blocking: MUERTA,
    });
    expect(planDeadGuideReplacement([MUERTA], "102371814", { replaceDead: true, only: "ship-dead", now: NOW }).retire).toEqual([MUERTA]);
  });

  it("otra salida viva de verdad bloquea, y entonces no se retira nada", () => {
    expect(planDeadGuideReplacement([MUERTA, viva], "102371814", { replaceDead: true, now: NOW })).toEqual({ retire: [], blocking: viva });
  });

  it("la propia guía no cuenta: reenviar el formulario es idempotente", () => {
    expect(planDeadGuideReplacement([MUERTA], "102321353", { replaceDead: true, now: NOW })).toEqual({ retire: [], blocking: null });
  });
});

describe("cómo queda la guía muerta", () => {
  const row: DeadGuideRow = {
    ...MUERTA,
    order_id: "o-1",
    status_category: "pending",
    pickup_state: "pendiente_de_envio",
    agency_branch: "AREQUIPA",
    shalom_codigo: "HWND",
    shalom_serie: "V1",
    shalom_ose_id: 55,
    shalom_order_id: 77,
    shalom_raw: { source: "shalom_pro_api" },
    last_report_at: "2026-11-03T21:30:29.536Z",
    shalom_checked_at: "2026-11-08T14:00:00.000Z",
    created_at: "2026-11-01T22:51:56.417Z",
  };
  const at = "2026-11-08T15:00:00.000Z";

  it("suelta: `anulado`, como «Anular guía Shalom»", () => {
    expect(deadGuideRetirePatch(row, "#KP201035", false, at)).toEqual({
      delivery_status: "anulado",
      status_category: "closed",
      pickup_state: null,
      updated_at: at,
    });
  });

  it("si rellenó una salida «por definir», vuelve a serlo —la misma caja— y sin la racha de la muerta", () => {
    const patch = deadGuideRetirePatch(row, "#KP201035", true, at);
    expect(patch).toMatchObject({
      courier: "por_definir",
      delivery_status: "pendiente",
      status_category: "pending",
      pickup_state: null,
      shalom_codigo: null,
      shalom_order_id: null,
      shalom_raw: null,
      last_report_at: null,
      shalom_checked_at: null,
      shalom_not_found_since: null,
      shalom_not_found_count: 0,
    });
    expect(String(patch.guide_code)).toMatch(/^MOM-KP201035-POR_DEFINIR-/);
    // Nunca la preparación ni la custodia: la caja sigue armada donde estaba.
    expect(patch).not.toHaveProperty("preparation_state");
    expect(patch).not.toHaveProperty("custody_state");
  });

  it("si registrar la nueva falla, vuelve a como estaba", () => {
    expect(deadGuideRestorePatch(row, false)).toEqual({
      delivery_status: "pendiente",
      status_category: "pending",
      pickup_state: "pendiente_de_envio",
    });
    expect(deadGuideRestorePatch(row, true)).toMatchObject({
      courier: "shalom",
      created_via: "shalom_pro_api",
      guide_code: "102321353",
      shalom_codigo: "HWND",
      shalom_order_id: 77,
      last_report_at: "2026-11-03T21:30:29.536Z",
      shalom_not_found_count: 40,
    });
  });

  it("la nota del `guide_cancelled` dice qué pasó y cuál la reemplaza", () => {
    expect(deadGuideCancelNote({ guide_code: "102321353", shalom_codigo: "HWND" }, "102371814", "cotejo")).toBe(
      "Guía Shalom 102321353 (código HWND) no existe en Shalom (no encontrada en el rastreo); reemplazada por la guía 102371814 creada en Shalom Pro (Cotejar Shalom).",
    );
    expect(deadGuideCancelNote({ guide_code: "102321353" }, "102371814", "drawer")).toBe(
      "Guía Shalom 102321353 no existe en Shalom (no encontrada en el rastreo); reemplazada por la guía 102371814 creada en Shalom Pro.",
    );
  });
});

// ---------------------------------------------------------------------------
// Cotejar Shalom: la guía que reemplaza a la muerta, con las mismas reglas
// ---------------------------------------------------------------------------

function guia(over: Partial<ShalomListingGuide> = {}): ShalomListingGuide {
  return {
    guia: "102371814",
    codigo: "W9NH",
    serie: "V9",
    listingId: 1,
    createdAt: "2026-11-04T15:00:00Z",
    document: "41059706",
    phone: "987654321",
    name: "MARIA QUISPE",
    ...over,
  };
}

function pedido(over: Partial<CotejoShalomOrder> = {}): CotejoShalomOrder {
  return {
    orderId: "o-201035",
    storeId: "kenku",
    orderName: "#KP201035",
    createdAt: "2026-10-29T23:39:58Z",
    customerName: "Maria Quispe",
    phone: "987654321",
    document: "41059706",
    candidate: true,
    replacing: { guideCode: "102321353", codigo: "HWND", createdAt: "2026-11-01T22:51:56Z" },
    ...over,
  };
}

/** La guía muerta está en Kapta: el listado, si la trae, la da por vinculada. */
const linked = new Set(["102321353"]);

describe("la guía que reemplaza a la muerta", () => {
  it("#KP201035: mismo DNI, sola y sin rivales → se vincula", () => {
    const [outcome] = matchShalomListing([guia()], [pedido()], linked, AMBOS);
    expect(outcome).toMatchObject({ kind: "vincular", via: "dni", guide: { guia: "102371814" } });
  });

  it("la propia guía muerta en el listado, con su mismo código, no estorba", () => {
    const muertaListada = guia({ guia: "102321353", codigo: "HWND", createdAt: "2026-11-01T22:52:00Z" });
    const [outcome] = matchShalomListing([muertaListada, guia()], [pedido()], linked, AMBOS);
    expect(outcome).toMatchObject({ kind: "vincular", guide: { guia: "102371814" } });
  });

  it("si el listado trae la muerta con OTRO código, no está muerta: no se reemplaza", () => {
    const conOtroCodigo = guia({ guia: "102321353", codigo: "D7MN", createdAt: "2026-11-01T22:52:00Z" });
    const [outcome] = matchShalomListing([conOtroCodigo, guia()], [pedido()], linked, AMBOS);
    expect(outcome).toMatchObject({ kind: "ambiguo" });
    expect(outcome?.kind === "ambiguo" && outcome.reason).toContain("código mal puesto");
    expect(deadGuideListingConflict(pedido().replacing!, [conOtroCodigo])).toContain("D7MN");
    expect(deadGuideListingConflict(pedido().replacing!, [guia({ guia: "102321353", codigo: " hwnd " })])).toBeNull();
  });

  it("dos guías posibles, o una que también podría ser de otro pedido de la clienta → para una persona", () => {
    const dos = matchShalomListing([guia(), guia({ guia: "102371999", codigo: "ZZ11" })], [pedido()], linked, AMBOS);
    expect(dos[0]).toMatchObject({ kind: "ambiguo" });
    const otroPedido = pedido({ orderId: "o-2", orderName: "#KP201999", createdAt: "2026-11-02T10:00:00Z", candidate: false, replacing: null });
    const rival = matchShalomListing([guia()], [pedido(), otroPedido], linked, AMBOS);
    expect(rival[0]).toMatchObject({ kind: "ambiguo" });
    expect(rival[0]!.kind === "ambiguo" && rival[0]!.reason).toContain("#KP201999");
  });

  it("sin guía en el listado, la muerta se queda como está: sin pareja", () => {
    expect(matchShalomListing([], [pedido()], linked, AMBOS)[0]).toMatchObject({ kind: "sin_pareja" });
  });

  it("la ventana empieza en la guía muerta: una guía anterior no la reemplaza", () => {
    // Del mismo DNI, creada antes que la muerta (y dentro de la ventana normal del pedido).
    const anterior = guia({ createdAt: "2026-10-30T10:00:00Z" });
    expect(guideInCandidateWindow(pedido(), anterior)).toBe(false);
    expect(guideInCandidateWindow(pedido({ replacing: null }), anterior)).toBe(true);
    expect(matchShalomListing([anterior], [pedido()], linked, AMBOS)[0]).toMatchObject({ kind: "sin_pareja" });
    // El día de margen por la zona horaria sigue valiendo.
    expect(guideInCandidateWindow(pedido(), guia({ createdAt: "2026-11-01T02:00:00Z" }))).toBe(true);
  });

  it("y termina 45 días después de lo último entre el pedido y la muerta", () => {
    // Pedido de agosto, guía muerta recreada el 01-11: la del 04-11 entra aunque
    // el pedido tenga más de 45 días.
    const viejo = pedido({ createdAt: "2026-08-20T10:00:00Z" });
    expect(guideInCandidateWindow(viejo, guia())).toBe(true);
    expect(guideInCandidateWindow(viejo, guia({ createdAt: "2026-12-20T10:00:00Z" }))).toBe(false);
  });
});

describe("el camino único, el drawer y Cotejar Shalom", () => {
  const register = read("lib/shalom/register-guide.ts");
  const cotejo = read("lib/shalom/account-cotejo.ts");
  const actions = read("app/dashboard/pedidos/shalom-actions.ts");

  it("register-guide retira la muerta antes de escribir la nueva y la devuelve si algo falla", () => {
    const body = register.slice(register.indexOf("export async function registerExistingShalomGuide"));
    const retire = body.indexOf("await retireDeadGuides(");
    expect(retire).toBeGreaterThan(-1);
    expect(retire).toBeLessThan(body.indexOf("await writeCourierGuide("));
    expect(body.match(/await restore\(\);/g)).toHaveLength(2);
    expect(register).toContain('kind: "guide_cancelled"');
    expect(register).toContain('.eq("guide_code", row.guide_code as string)');
  });

  it("Cotejar Shalom busca a los pedidos con guía muerta y reemplaza solo la que cotejó", () => {
    expect(cotejo).toContain("const dead = await loadDeadCandidates(admin, report.errores);");
    expect(cotejo).toContain("replaceDead: { only: row.replacing.shipmentId }");
    expect(cotejo).toContain("!dead.deadCodes.has(guideCodeKey(k.guide_code))");
    expect(cotejo).toContain("onlyIfNew: true");
  });

  it("el drawer no se bloquea: la guía muerta no va a `contingencyBlockers` y se reemplaza al registrar", () => {
    expect(actions).toContain("registerExistingShalomGuide(admin, row, guide, { actor: userId, replaceDead: {} })");
    const draft = actions.slice(actions.indexOf("for (const g of await activeGuides(admin, orderId))"));
    expect(draft.indexOf("isConfirmedDeadShalomGuide(g)")).toBeLessThan(draft.indexOf("contingencyBlockers.push("));
  });

  it("el MOM y DEPLOY lo dicen", () => {
    const mom = flat(read("docs/mom/master-pedidos-v1.md"));
    expect(mom).toContain("#### La guía muerta y la que se creó a mano en su lugar (decidido el 08-11-2026)");
    expect(mom).toContain("no existe en Shalom (no encontrada en el rastreo); reemplazada por la guía");
    const deploy = read("DEPLOY.md");
    const first = deploy.indexOf("\n### ");
    expect(flat(deploy.slice(first, deploy.indexOf("\n### ", first + 10)))).toContain("Cotejar Shalom reemplaza la guía muerta");
  });
});
