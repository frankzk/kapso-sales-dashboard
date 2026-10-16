import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { asOrderCoverage, leadDeliveryProbe } from "@/lib/lead-delivery-coverage";
import type { OrderShippingAddress } from "@/lib/types";

/**
 * La cobertura en «Entrega» del siguiente lead y de la ficha (MOM §11,
 * 14-10-2026): la del Master (`order_coverage_for`), preguntada con la
 * dirección del carrito armada como la del pedido.
 */

const shipping = (extra: Partial<OrderShippingAddress> = {}): OrderShippingAddress => ({
  address1: "Jr. Yauli 359",
  address2: null,
  city: "Chaupimarca",
  province: "Pasco",
  name: null,
  phone: null,
  latitude: -10.68,
  longitude: -76.26,
  ...extra,
});

describe("leadDeliveryProbe", () => {
  it("arma la ubicación como el pedido: provincia del INEI por el distrito y la coordenada del carrito", () => {
    expect(
      leadDeliveryProbe(
        { district: "Chaupimarca", province: "Pasco", region: "Pasco" },
        { province: "Pasco", department: "Pasco" },
        shipping(),
      ),
    ).toEqual({ region: "Pasco", province: "Pasco", district: "Chaupimarca", latitude: -10.68, longitude: -76.26 });
  });

  it("Shopify llama «province» al departamento: sin ubigeo se usa ese, y la región cae al departamento", () => {
    expect(leadDeliveryProbe({ district: "Sullana", province: "Piura", region: null }, null, null)).toEqual({
      region: "Piura",
      province: "Piura",
      district: "Sullana",
      latitude: null,
      longitude: null,
    });
    // Con ubigeo, la provincia del INEI gana y la región sale del lead.
    expect(
      leadDeliveryProbe(
        { district: "Tambopata", province: "Madre de Dios", region: "Madre de Dios" },
        { province: "Tambopata", department: "Madre de Dios" },
        null,
      )?.province,
    ).toBe("Tambopata");
  });

  it("sin un distrito que sirva no pregunta: «-» o vacío no es una dirección", () => {
    for (const district of [null, "", "  ", "-", ".", "s/n"]) {
      expect(leadDeliveryProbe({ district, province: "Lima (departamento)", region: "Lima (departamento)" }, null, shipping())).toBeNull();
    }
  });

  it("la coordenada del carrito solo entra si es del mismo distrito", () => {
    const otro = leadDeliveryProbe({ district: "Huancayo", province: "Junín", region: "Junín" }, null, shipping());
    expect(otro?.latitude).toBeNull();
    expect(otro?.longitude).toBeNull();
    // Mayúsculas y tildes no cuentan como otro distrito.
    const mismo = leadDeliveryProbe({ district: "CHAUPIMARCA", province: "Pasco", region: null }, null, shipping({ city: "chaupimarca " }));
    expect(mismo?.latitude).toBe(-10.68);
  });

  it("media coordenada no ubica nada", () => {
    const probe = leadDeliveryProbe({ district: "Chaupimarca", province: "Pasco", region: null }, null, shipping({ longitude: null }));
    expect(probe?.latitude).toBeNull();
    expect(probe?.longitude).toBeNull();
  });
});

describe("asOrderCoverage", () => {
  it("acepta solo las coberturas del Master", () => {
    expect(asOrderCoverage("lima")).toBe("lima");
    expect(asOrderCoverage("provincia_cod")).toBe("provincia_cod");
    expect(asOrderCoverage("agencia")).toBe("agencia");
    expect(asOrderCoverage("por_revisar")).toBe("por_revisar");
    expect(asOrderCoverage("provincia")).toBeNull();
    expect(asOrderCoverage(null)).toBeNull();
    expect(asOrderCoverage(3)).toBeNull();
  });
});

describe("loadLeadDeliveryCoverage", () => {
  const actions = readFileSync(resolve(__dirname, "../app/dashboard/leads/actions.ts"), "utf8");
  const route = readFileSync(resolve(__dirname, "../app/api/leads/read/route.ts"), "utf8");

  it("pregunta a la definición canónica del Master con la coordenada, no a una lista propia", () => {
    const body = actions.slice(actions.indexOf("export async function loadLeadDeliveryCoverage"));
    expect(body).toMatch(/rpc\("order_coverage_for",\s*\{[^}]*p_lat: probe\.latitude[^}]*p_lng: probe\.longitude/s);
  });

  it("es una lectura de la ruta de Leads, autorizada por lead", () => {
    expect(route).toMatch(/loadLeadDeliveryCoverage: lead,/);
  });
});
