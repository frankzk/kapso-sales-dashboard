import { describe, it, expect } from "vitest";
import {
  AUTO_TRIAL_MAX_CART_AGE_DAYS,
  AUTO_TRIAL_TAG,
  isLaterOrderOf,
  isUsableAddress,
  processAutoOrderTrials,
  trialAddress,
  trialSkipReason,
  type AutoOrderTrialRow,
  type AutoTrialDeps,
  type TrialDraft,
  type TrialLead,
} from "@/lib/auto-order-trials";

// Prueba de pedidos automáticos de recompra (MOM, 02-10-2026): un carrito
// autorizado a mano se convierte en pedido sin llamada, SOLO si al momento de
// generarlo sigue siendo lo que se autorizó.

const NOW = Date.parse("2026-10-02T15:00:00Z");
const GID = "gid://shopify/DraftOrder/1234567";

const row = (over: Partial<AutoOrderTrialRow> = {}): AutoOrderTrialRow => ({
  id: "t1",
  store_id: "s1",
  lead_id: "l1",
  draft_order_gid: GID,
  draft_name: "#D98585",
  cohort: "exp-recompra-1",
  grupo: "A",
  address1: null,
  referencia: null,
  district: null,
  province: null,
  ...over,
});

const lead = (over: Partial<TrialLead> = {}): TrialLead => ({
  id: "l1",
  phone: "51987654321",
  status: "nuevo",
  category: "open",
  draft_order_gid: GID,
  ...over,
});

const draft = (over: Partial<TrialDraft> = {}): TrialDraft => ({
  draft_order_gid: GID,
  name: "#D98585",
  status: "open",
  created_at: "2026-09-29T04:34:15Z",
  total_amount: 149,
  currency: "PEN",
  customer_phone: "51987654321",
  customer_name: "Rosa Quispe",
  address1: "Av. Perú 123",
  referencia: null,
  district: "Juliaca",
  province: "Puno",
  region: "Puno",
  ...over,
});

const reason = (over: Partial<Parameters<typeof trialSkipReason>[0]> = {}) =>
  trialSkipReason({ row: row(), lead: lead(), draft: draft(), laterOrder: false, nowMs: NOW, ...over });

describe("trialSkipReason (la regla de la prueba)", () => {
  it("un carrito vigente, sin gestionar y con dirección → se genera", () => {
    expect(reason()).toBeNull();
  });

  it("si una asesora ya lo gestionó, manda su decisión", () => {
    expect(reason({ lead: lead({ status: "cancelado", category: "lost" }) })).toBe("lead_cancelado");
    expect(reason({ lead: lead({ status: "volver_a_llamar", category: "open" }) })).toBe("lead_volver_a_llamar");
    expect(reason({ lead: lead({ status: "pedido_generado", category: "won" }) })).toBe("lead_pedido_generado");
  });

  it("un lead caliente por señal del bot tampoco se toca: no es «sin gestionar»", () => {
    expect(reason({ lead: lead({ status: "casi_cierra", category: "hot" }) })).toBe("lead_casi_cierra");
  });

  it("sin lead no hay a quién ganar", () => {
    expect(reason({ lead: null })).toBe("lead_no_existe");
  });

  it("si el cliente armó OTRO carrito, el autorizado ya no es su compra", () => {
    expect(reason({ lead: lead({ draft_order_gid: "gid://shopify/DraftOrder/999" }) })).toBe("carrito_reemplazado");
  });

  it("un carrito completado o borrado no se vuelve a completar", () => {
    expect(reason({ draft: draft({ status: "completed" }) })).toBe("carrito_cerrado");
    expect(reason({ draft: null })).toBe("carrito_no_encontrado");
  });

  it("invoice_sent sigue siendo un carrito abierto", () => {
    expect(reason({ draft: draft({ status: "invoice_sent" }) })).toBeNull();
  });

  it("un total en cero no se completa: Shopify lo daría por pagado", () => {
    expect(reason({ draft: draft({ total_amount: 0 }) })).toBe("total_cero");
    expect(reason({ draft: draft({ total_amount: null }) })).toBe("total_cero");
  });

  it(`un carrito de más de ${AUTO_TRIAL_MAX_CART_AGE_DAYS} días ya no se genera`, () => {
    const old = new Date(NOW - (AUTO_TRIAL_MAX_CART_AGE_DAYS + 1) * 86_400_000).toISOString();
    expect(reason({ draft: draft({ created_at: old }) })).toBe("carrito_vencido");
    expect(reason({ draft: draft({ created_at: null }) })).toBe("carrito_sin_fecha");
  });

  it("si ya compró después del carrito, no se le genera otro", () => {
    expect(reason({ laterOrder: true })).toBe("ya_tiene_pedido_posterior");
  });

  it("un carrito con «-» como dirección no sale sin una dirección de la fila", () => {
    expect(reason({ draft: draft({ address1: "-" }) })).toBe("sin_direccion");
    expect(reason({ draft: draft({ district: "-" }) })).toBe("sin_direccion");
    expect(
      reason({ row: row({ grupo: "B", address1: "Av. Parinacochas 731" }), draft: draft({ address1: "-" }) }),
    ).toBeNull();
  });
});

describe("trialAddress", () => {
  it("sin dirección en la fila se respeta la del carrito", () => {
    expect(trialAddress(row(), draft())).toBeNull();
  });

  it("la fila manda campo a campo y el resto sale del carrito", () => {
    const a = trialAddress(row({ grupo: "B", address1: "Av. Parinacochas 731", district: "La Victoria" }), draft({ address1: "-" }));
    expect(a).toMatchObject({
      name: "Rosa Quispe",
      phone: "51987654321",
      address1: "Av. Parinacochas 731",
      city: "La Victoria",
      province: "Puno",
    });
  });
});

describe("isUsableAddress", () => {
  it("rechaza los rellenos del formulario COD", () => {
    for (const v of ["-", ".", "x", "  ", null, "s/n"]) expect(isUsableAddress(v)).toBe(false);
  });
  it("acepta una dirección real", () => {
    expect(isUsableAddress("Jr. Pisagua 848")).toBe(true);
    expect(isUsableAddress("Psje Honduras 260")).toBe(true);
  });
});

describe("isLaterOrderOf", () => {
  const cart = "2026-09-29T04:34:15Z";
  it("mismo cliente, posterior y no anulado → ya compró", () => {
    expect(isLaterOrderOf("51987654321", cart, { customer_phone: "+51 987 654 321", created_at: "2026-09-30T10:00:00Z" })).toBe(true);
  });
  it("un pedido anterior al carrito o anulado no cuenta", () => {
    expect(isLaterOrderOf("51987654321", cart, { customer_phone: "987654321", created_at: "2026-09-20T10:00:00Z" })).toBe(false);
    expect(
      isLaterOrderOf("51987654321", cart, { customer_phone: "987654321", created_at: "2026-09-30T10:00:00Z", cancelled_at: "2026-09-30T11:00:00Z" }),
    ).toBe(false);
  });
  it("otro teléfono no cuenta", () => {
    expect(isLaterOrderOf("51987654321", cart, { customer_phone: "51911111111", created_at: "2026-09-30T10:00:00Z" })).toBe(false);
  });
});

// --- Procesador con dependencias falsas ---------------------------------------

function fakeDeps(over: Partial<AutoTrialDeps> & { rows?: AutoOrderTrialRow[] } = {}) {
  const calls: string[] = [];
  const finished: Record<string, Record<string, unknown>> = {};
  const deps: AutoTrialDeps = {
    listPending: async () => over.rows ?? [row()],
    claim: async () => true,
    loadLead: async () => lead(),
    loadDraft: async () => draft(),
    hasLaterOrder: async () => false,
    liveDraftStatus: async () => "open",
    completeDraft: async (gid) => {
      calls.push(`complete:${gid}`);
      return { orderGid: "gid://shopify/Order/5550001", orderName: "#KP140001" };
    },
    setOrderAddress: async (gid, a) => {
      calls.push(`address:${gid}:${a.address1}`);
    },
    tagOrder: async (gid, tags) => {
      calls.push(`tags:${gid}:${tags.join(",")}`);
    },
    recordOrder: async ({ orderGid }) => {
      calls.push(`record:${orderGid}`);
      return "2026-10-02T15:00:05Z";
    },
    finish: async (id, patch) => {
      finished[id] = patch;
    },
    now: () => NOW,
    ...over,
  };
  return { deps, calls, finished };
}

describe("processAutoOrderTrials", () => {
  it("completa el carrito, lo etiqueta y lo registra; la fila queda generada", async () => {
    const { deps, calls, finished } = fakeDeps();
    const r = await processAutoOrderTrials(deps);
    expect(r).toMatchObject({ generated: 1, skipped: 0, failed: 0, orderDates: ["2026-10-02T15:00:05Z"] });
    expect(calls).toEqual([
      `complete:${GID}`,
      `tags:gid://shopify/Order/5550001:${AUTO_TRIAL_TAG},exp-recompra-1`,
      "record:gid://shopify/Order/5550001",
    ]);
    expect(finished.t1).toMatchObject({
      status: "generado",
      shopify_order_id: "5550001",
      order_name: "#KP140001",
      reason: null,
    });
  });

  it("grupo B: pone la dirección de la fila en el pedido ANTES de registrarlo", async () => {
    const { deps, calls } = fakeDeps({
      rows: [row({ grupo: "B", address1: "Av. Canevaro 1275", district: "Lince" })],
      loadDraft: async () => draft({ address1: "-" }),
    });
    await processAutoOrderTrials(deps);
    expect(calls[1]).toBe("address:gid://shopify/Order/5550001:Av. Canevaro 1275");
    expect(calls.indexOf("record:gid://shopify/Order/5550001")).toBeGreaterThan(1);
  });

  it("si la regla dice que no, no toca Shopify y deja el motivo", async () => {
    const { deps, calls, finished } = fakeDeps({ loadLead: async () => lead({ status: "cancelado", category: "lost" }) });
    const r = await processAutoOrderTrials(deps);
    expect(r.skipped).toBe(1);
    expect(calls).toEqual([]);
    expect(finished.t1).toMatchObject({ status: "omitido", reason: "lead_cancelado" });
  });

  it("nuestra copia dice abierto pero Shopify ya lo cerró → no se completa", async () => {
    const { deps, calls, finished } = fakeDeps({ liveDraftStatus: async () => "completed" });
    await processAutoOrderTrials(deps);
    expect(calls).toEqual([]);
    expect(finished.t1).toMatchObject({ status: "omitido", reason: "carrito_cerrado_en_shopify" });
  });

  it("una fila que otra corrida ya tomó no se procesa dos veces", async () => {
    const { deps, calls, finished } = fakeDeps({ claim: async () => false });
    const r = await processAutoOrderTrials(deps);
    expect(r).toMatchObject({ generated: 0, skipped: 0, failed: 0 });
    expect(calls).toEqual([]);
    expect(finished).toEqual({});
  });

  it("si Shopify dice que ya estaba completado, es omitido, no error", async () => {
    const { deps, finished } = fakeDeps({
      completeDraft: async () => {
        throw new Error("draftOrderComplete: Draft order has already been completed");
      },
    });
    await processAutoOrderTrials(deps);
    expect(finished.t1).toMatchObject({ status: "omitido", reason: "carrito_ya_completado" });
  });

  it("un fallo al completar deja la fila en error y sigue con la siguiente", async () => {
    let n = 0;
    const { deps, finished } = fakeDeps({
      rows: [row({ id: "t1" }), row({ id: "t2" })],
      completeDraft: async () => {
        n += 1;
        if (n === 1) throw new Error("Shopify GraphQL HTTP 502");
        return { orderGid: "gid://shopify/Order/5550002", orderName: "#KP140002" };
      },
    });
    const r = await processAutoOrderTrials(deps);
    expect(r).toMatchObject({ generated: 1, failed: 1 });
    expect(finished.t1).toMatchObject({ status: "error", reason: "Shopify GraphQL HTTP 502" });
    expect(finished.t2).toMatchObject({ status: "generado", order_name: "#KP140002" });
  });

  it("con el pedido ya creado, lo que falle después se anota pero la fila queda generada", async () => {
    const { deps, finished } = fakeDeps({
      tagOrder: async () => {
        throw new Error("Access denied for tagsAdd");
      },
    });
    const r = await processAutoOrderTrials(deps);
    expect(r.generated).toBe(1);
    expect(finished.t1).toMatchObject({ status: "generado" });
    expect(String(finished.t1!.reason)).toContain("etiqueta no aplicada");
  });
});
