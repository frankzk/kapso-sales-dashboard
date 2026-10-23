// La foto del carrito en la tarjeta del siguiente lead (`loadNextLeadCart`)
// desde el cierre de Shopify (MOM §39): sale por /api/wa-image igual que en las
// plantillas, así que desde el 28-10-2026, en Kenku y Aurela, solo se muestra
// la que tiene copia guardada; antes, o en una tienda cliente, como siempre,
// sin mirar Storage.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  url: "https://cdn.shopify.com/s/files/1/x/files/serum.webp?v=1",
  stored: [] as string[],
  listed: [] as string[],
  // La fila de la tienda: Kenku, con WooCommerce conectado (MOM §38).
  store: { shopify_token_enc: "enc:token", platform: "shopify", woo_site_url: "https://kenku.pe" } as Record<string, unknown>,
}));
const URL_111 = mocks.url;
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/agent-names", () => ({ resolveAgentName: vi.fn(), resolveAgentNames: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@/lib/db", () => {
  const chain = (data: unknown) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "in"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data, error: null });
    q.then = (res: (r: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res);
    return q;
  };
  const rows: Record<string, unknown> = {
    leads: { draft_order_gid: "gid://shopify/DraftOrder/1" },
    draft_orders: {
      line_items: [{ title: "Sérum Uñas", quantity: 1, product_id: null }],
      created_at: "2026-10-29T10:00:00Z",
    },
    shopify_product_images: [{ product_id: "111", catalog_title: "Sérum Uñas", image_url: mocks.url }],
    get stores() {
      return mocks.store;
    },
  };
  return {
    createServerSupabase: async () => ({
      auth: { getClaims: async () => ({ data: { claims: { sub: "asesora" } } }) },
      from: () => chain({ store_id: "store-1", phone: "51900000001", kapso_conversation_id: null, wa_phone_number_id: null }),
    }),
    createAdminSupabase: () => ({
      from: (table: string) => chain(rows[table] ?? null),
      storage: {
        from: () => ({
          list: async (prefix: string, o: { offset: number }) => {
            mocks.listed.push(prefix);
            return { data: o.offset ? [] : mocks.stored.map((name) => ({ name, id: name })), error: null };
          },
        }),
      },
    }),
  };
});

import { loadNextLeadCart } from "@/app/dashboard/leads/actions";
import { productPhotoName } from "@/lib/product-photos";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  mocks.stored = [];
  mocks.listed = [];
  mocks.store = { shopify_token_enc: "enc:token", platform: "shopify", woo_site_url: "https://kenku.pe" };
});
afterEach(() => vi.useRealTimers());

describe("loadNextLeadCart: la foto del carrito", () => {
  it("antes del cierre, la del espejo, sin mirar Storage", async () => {
    vi.setSystemTime(new Date("2026-10-27T15:00:00Z"));
    const cart = await loadNextLeadCart("lead-1");
    expect(cart).toMatchObject({ photoUrl: "/api/wa-image/store-1/111.jpg" });
    expect(mocks.listed).toEqual([]);
  });

  it("desde el cierre, con la copia guardada, la misma foto", async () => {
    vi.setSystemTime(new Date("2026-10-29T15:00:00Z"));
    mocks.stored = [productPhotoName("111", URL_111)];
    expect(await loadNextLeadCart("lead-1")).toMatchObject({ photoUrl: "/api/wa-image/store-1/111.jpg" });
    expect(mocks.listed[0]).toBe("store-1");
  });

  it("desde el cierre, en una tienda cliente (sigue en Shopify), la del espejo sin mirar Storage", async () => {
    vi.setSystemTime(new Date("2026-10-29T15:00:00Z"));
    mocks.store = { ...mocks.store, woo_site_url: null };
    expect(await loadNextLeadCart("lead-1")).toMatchObject({ photoUrl: "/api/wa-image/store-1/111.jpg" });
    expect(mocks.listed).toEqual([]);
  });

  it("desde el cierre, sin copia, la tarjeta se queda sin foto (no un hueco roto)", async () => {
    vi.setSystemTime(new Date("2026-10-29T15:00:00Z"));
    const cart = await loadNextLeadCart("lead-1");
    expect(cart).toMatchObject({ photoUrl: null, lines: [expect.objectContaining({ title: "Sérum Uñas" })] });
  });
});
