import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AUTO_TRIAL_MAX_CART_AGE_DAYS,
  AUTO_TRIAL_PLATFORM_REASON,
  AUTO_TRIAL_TAG,
  isLaterOrderOf,
  isUsableAddress,
  processAutoOrderTrials,
  readTrialStorePlatform,
  trialAddress,
  trialSkipReason,
  type AutoOrderTrialRow,
  type AutoTrialDeps,
  type TrialDraft,
  type TrialLead,
  type TrialStorePlatform,
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
    storePlatform: async () => "shopify",
    claim: async () => true,
    loadLead: async () => lead(),
    loadDraft: async () => draft(),
    hasLaterOrder: async () => false,
    liveDraftStatus: async () => "open",
    completeDraft: async (gid) => {
      calls.push(`complete:${gid}`);
      return { orderGid: "gid://shopify/Order/5550001", orderName: "#KP140001" };
    },
    setDraftAddress: async (gid, a) => {
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
    expect(r).toMatchObject({
      generated: 1,
      skipped: 0,
      failed: 0,
      blockedByPlatform: 0,
      error: null,
      orderDates: ["2026-10-02T15:00:05Z"],
    });
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

  it("grupo B: la dirección va al BORRADOR antes de completarlo", async () => {
    const { deps, calls } = fakeDeps({
      rows: [row({ grupo: "B", address1: "Av. Canevaro 1275", district: "Lince" })],
      loadDraft: async () => draft({ address1: "-" }),
    });
    await processAutoOrderTrials(deps);
    expect(calls.slice(0, 2)).toEqual([`address:${GID}:Av. Canevaro 1275`, `complete:${GID}`]);
  });

  it("grupo B: si el borrador no acepta la dirección, NO se genera el pedido", async () => {
    // Así salieron seis pedidos con la «-» del formulario el 02-10-2026: la
    // dirección se corregía DESPUÉS de crear el pedido y Shopify lo negó.
    const { deps, calls, finished } = fakeDeps({
      rows: [row({ grupo: "B", address1: "Av. Canevaro 1275", district: "Lince" })],
      loadDraft: async () => draft({ address1: "-" }),
      setDraftAddress: async () => {
        throw new Error("Access denied for draftOrderUpdate field.");
      },
    });
    const r = await processAutoOrderTrials(deps);
    expect(r).toMatchObject({ generated: 0, skipped: 1 });
    expect(calls).toEqual([]);
    expect(String(finished.t1!.reason)).toMatch(/^direccion_no_aplicada: Access denied/);
  });

  it("sin dirección propia en la fila no toca la del carrito", async () => {
    const { deps, calls } = fakeDeps();
    await processAutoOrderTrials(deps);
    expect(calls.some((c) => c.startsWith("address:"))).toBe(false);
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
        throw new Error("Shopify GraphQL errors: Access denied for tagsAdd field.");
      },
    });
    const r = await processAutoOrderTrials(deps);
    expect(r.generated).toBe(1);
    expect(finished.t1).toMatchObject({ status: "generado" });
    expect(finished.t1!.reason).toBe("etiqueta no aplicada: falta permiso write_orders");
  });
});

// --- La plataforma de la tienda (MOM §38.12, «Los carritos», 25-10-2026) --------
//
// El pedido de la prueba es el borrador de Shopify completado. `stores.platform`
// dice dónde crea Kapta los pedidos nuevos de la tienda (§38.1): con
// `woocommerce`, completar el borrador sería un pedido en la plataforma
// equivocada. La prueba no lo hace y deja el motivo en la fila.

describe("processAutoOrderTrials · la plataforma de la tienda", () => {
  /** Las dependencias que tocan Shopify o el lead: ninguna debe llamarse. */
  function noShopify(calls: string[]): Partial<AutoTrialDeps> {
    return {
      loadLead: async () => {
        calls.push("loadLead");
        return lead();
      },
      loadDraft: async () => {
        calls.push("loadDraft");
        return draft();
      },
      hasLaterOrder: async () => {
        calls.push("hasLaterOrder");
        return false;
      },
      liveDraftStatus: async () => {
        calls.push("liveDraftStatus");
        return "open";
      },
    };
  }

  it("en una tienda que crea en WooCommerce no toca Shopify: omitido con su motivo", async () => {
    const calls: string[] = [];
    const { deps, calls: shopify, finished } = fakeDeps({
      storePlatform: async () => "woocommerce",
      ...noShopify(calls),
    });
    const r = await processAutoOrderTrials(deps);
    expect(r).toMatchObject({ generated: 0, skipped: 1, failed: 0, blockedByPlatform: 1, error: null, orderDates: [] });
    expect(calls).toEqual([]);
    expect(shopify).toEqual([]);
    expect(finished.t1).toMatchObject({ status: "omitido", reason: AUTO_TRIAL_PLATFORM_REASON });
    expect(AUTO_TRIAL_PLATFORM_REASON).toBe("tienda_en_woocommerce");
  });

  it("cada fila de la corrida queda omitida y cuenta", async () => {
    const { deps, calls, finished } = fakeDeps({
      rows: [row({ id: "t1" }), row({ id: "t2" })],
      storePlatform: async () => "woocommerce",
    });
    const r = await processAutoOrderTrials(deps);
    expect(r).toMatchObject({ skipped: 2, blockedByPlatform: 2 });
    expect(calls).toEqual([]);
    expect(finished.t1).toMatchObject({ status: "omitido", reason: "tienda_en_woocommerce" });
    expect(finished.t2).toMatchObject({ status: "omitido", reason: "tienda_en_woocommerce" });
  });

  it("si la plataforma no se puede leer, no toma la fila: sigue pendiente y la corrida lo dice", async () => {
    const claimed: string[] = [];
    for (const storePlatform of [async () => null, async () => Promise.reject(new Error("timeout"))]) {
      const { deps, calls, finished } = fakeDeps({
        rows: [row({ id: "t1" }), row({ id: "t2" })],
        storePlatform: storePlatform as () => Promise<TrialStorePlatform | null>,
        claim: async (id) => {
          claimed.push(id);
          return true;
        },
      });
      const r = await processAutoOrderTrials(deps);
      expect(r).toMatchObject({ generated: 0, skipped: 0, failed: 0, blockedByPlatform: 0 });
      expect(r.error).toMatch(/^no se pudo leer en qué plataforma crea sus pedidos la tienda/);
      expect(r.error).toContain("siguen pendientes");
      expect(calls).toEqual([]);
      expect(finished).toEqual({});
    }
    expect(claimed).toEqual([]);
  });

  it("se mira en cada fila: un cambio a WooCommerce a mitad de corrida frena las siguientes", async () => {
    const platforms: TrialStorePlatform[] = ["shopify", "woocommerce"];
    const { deps, calls, finished } = fakeDeps({
      rows: [row({ id: "t1" }), row({ id: "t2" })],
      storePlatform: async () => platforms.shift() ?? "woocommerce",
    });
    const r = await processAutoOrderTrials(deps);
    expect(r).toMatchObject({ generated: 1, skipped: 1, blockedByPlatform: 1 });
    expect(calls.filter((c) => c.startsWith("complete:"))).toHaveLength(1);
    expect(finished.t1).toMatchObject({ status: "generado" });
    expect(finished.t2).toMatchObject({ status: "omitido", reason: "tienda_en_woocommerce" });
  });

  it("si la lectura falla después de generar una fila, lo generado se informa igual", async () => {
    const platforms: (TrialStorePlatform | null)[] = ["shopify", null];
    const { deps, finished } = fakeDeps({
      rows: [row({ id: "t1" }), row({ id: "t2" })],
      storePlatform: async () => platforms.shift() ?? null,
    });
    const r = await processAutoOrderTrials(deps);
    expect(r).toMatchObject({ generated: 1, orderDates: ["2026-10-02T15:00:05Z"] });
    expect(r.error).not.toBeNull();
    expect(finished.t2).toBeUndefined();
  });
});

describe("readTrialStorePlatform (stores.platform, sin claves)", () => {
  function fakeAdmin(result: { data: unknown; error: { code?: string; message: string } | null }) {
    const seen: { table?: string; columns?: string; id?: unknown } = {};
    const admin = {
      from(table: string) {
        seen.table = table;
        return {
          select(columns: string) {
            seen.columns = columns;
            return {
              eq(_col: string, id: unknown) {
                seen.id = id;
                return { maybeSingle: async () => result };
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient;
    return { admin, seen };
  }

  it("lee solo la columna platform de esa tienda", async () => {
    const { admin, seen } = fakeAdmin({ data: { platform: "woocommerce" }, error: null });
    expect(await readTrialStorePlatform(admin, "s1")).toBe("woocommerce");
    expect(seen).toEqual({ table: "stores", columns: "platform", id: "s1" });
  });

  it("shopify es shopify; sin la 0274 (la columna no existe) toda tienda es de Shopify", async () => {
    expect(await readTrialStorePlatform(fakeAdmin({ data: { platform: "shopify" }, error: null }).admin, "s1")).toBe(
      "shopify",
    );
    expect(
      await readTrialStorePlatform(
        fakeAdmin({ data: null, error: { code: "42703", message: "column stores.platform does not exist" } }).admin,
        "s1",
      ),
    ).toBe("shopify");
  });

  it("un error, una tienda que no está o un valor raro: null, nunca «Shopify» por defecto", async () => {
    expect(
      await readTrialStorePlatform(fakeAdmin({ data: null, error: { message: "canceling statement due to statement timeout" } }).admin, "s1"),
    ).toBeNull();
    expect(await readTrialStorePlatform(fakeAdmin({ data: null, error: null }).admin, "s1")).toBeNull();
    expect(await readTrialStorePlatform(fakeAdmin({ data: { platform: "magento" }, error: null }).admin, "s1")).toBeNull();
    expect(await readTrialStorePlatform(fakeAdmin({ data: { platform: null }, error: null }).admin, "s1")).toBeNull();
  });
});
