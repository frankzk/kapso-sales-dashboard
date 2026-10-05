import { describe, expect, it } from "vitest";
import { getCustomerAddressByPhone, parseCustomerAddress } from "@/lib/shopify";
import { enrichLeadLocationsFromShopify } from "@/lib/lead-shopify-location";

const shopify = { domain: "tienda.myshopify.com", token: "tok" };

describe("parseCustomerAddress", () => {
  it("lee la dirección por defecto del primer cliente", () => {
    expect(
      parseCustomerAddress({
        customers: { edges: [{ node: { defaultAddress: { province: "Lima (provincia)", city: " Surco " } } }] },
      }),
    ).toEqual({ province: "Lima (provincia)", city: "Surco" });
  });

  it("null si no hay cliente, o si no tiene dirección", () => {
    expect(parseCustomerAddress({ customers: { edges: [] } })).toBeNull();
    expect(parseCustomerAddress({ customers: { edges: [{ node: { defaultAddress: null } }] } })).toBeNull();
    expect(
      parseCustomerAddress({ customers: { edges: [{ node: { defaultAddress: { province: "", city: null } } }] } }),
    ).toBeNull();
  });
});

describe("getCustomerAddressByPhone", () => {
  const respond = (body: unknown, status = 200) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("busca por celular en E.164 y devuelve la dirección", async () => {
    let sent = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = String(init.body);
      return new Response(
        JSON.stringify({
          data: { customers: { edges: [{ node: { defaultAddress: { province: "Arequipa", city: "Cayma" } } }] } },
        }),
      );
    }) as unknown as typeof fetch;
    const res = await getCustomerAddressByPhone({ ...shopify, fetchImpl }, "51 987 654 321");
    expect(res).toEqual({ found: true, province: "Arequipa", city: "Cayma" });
    expect(sent).toContain("phone:+51987654321");
  });

  it("sin cliente es found:false (se marca como consultado)", async () => {
    const res = await getCustomerAddressByPhone(
      { ...shopify, fetchImpl: respond({ data: { customers: { edges: [] } } }) },
      "51987654321",
    );
    expect(res).toEqual({ found: false });
  });

  it("si Shopify falla, LANZA: no se marca y se reintenta", async () => {
    await expect(
      getCustomerAddressByPhone({ ...shopify, fetchImpl: respond({ errors: [{ message: "ACCESS_DENIED" }] }) }, "51987654321"),
    ).rejects.toThrow(/ACCESS_DENIED/);
  });
});

describe("enrichLeadLocationsFromShopify", () => {
  function fakeAdmin(candidates: { lead_id: string; phone: string }[] | null, rpcError: unknown = null) {
    const upserts: Record<string, unknown>[] = [];
    const admin = {
      rpc: async () => ({ data: candidates, error: rpcError }),
      from: () => ({
        upsert: async (row: Record<string, unknown>) => {
          upserts.push(row);
          return { error: null };
        },
      }),
    };
    return { admin: admin as never, upserts };
  }

  it("guarda una fila por lead consultado, con o sin dirección", async () => {
    const { admin, upserts } = fakeAdmin([
      { lead_id: "a", phone: "51900000001" },
      { lead_id: "b", phone: "51900000002" },
    ]);
    const stats = await enrichLeadLocationsFromShopify(admin, "store-1", shopify, 30, async (_o, phone) =>
      phone === "51900000001" ? { found: true, province: "Cusco", city: "Cusco" } : { found: false },
    );
    expect(stats).toEqual({ checked: 2, found: 1 });
    expect(upserts.map((r) => [r.lead_id, r.province, r.city])).toEqual([
      ["a", "Cusco", "Cusco"],
      ["b", null, null],
    ]);
  });

  it("a la primera falla corta la corrida sin marcar ese lead", async () => {
    const { admin, upserts } = fakeAdmin([
      { lead_id: "a", phone: "51900000001" },
      { lead_id: "b", phone: "51900000002" },
      { lead_id: "c", phone: "51900000003" },
    ]);
    let calls = 0;
    const stats = await enrichLeadLocationsFromShopify(admin, "store-1", shopify, 30, async () => {
      calls += 1;
      if (calls === 2) throw new Error("Shopify GraphQL HTTP 503");
      return { found: false };
    });
    expect(calls).toBe(2);
    expect(upserts.map((r) => r.lead_id)).toEqual(["a"]);
    expect(stats.checked).toBe(1);
    expect(stats.error).toMatch(/503/);
  });

  it("sin la migración (la función no existe) no hace nada", async () => {
    const { admin, upserts } = fakeAdmin(null, { message: "function does not exist" });
    const stats = await enrichLeadLocationsFromShopify(admin, "store-1", shopify, 30, async () => {
      throw new Error("no debería llamarse");
    });
    expect(stats).toEqual({ checked: 0, found: 0 });
    expect(upserts).toHaveLength(0);
  });
});
