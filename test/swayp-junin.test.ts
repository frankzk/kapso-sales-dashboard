// Junín sale de la bodega de Huancayo (owner, 07-11-2026, #KP202768; MOM §11,
// «cobertura por ubigeo»). La dirección de Shopify trae «El Tambo» y «Junín»,
// nunca «Huancayo», y la Mesa de ruta decía «Swayp no tiene cobertura local en
// este destino» aunque Swayp ya había entregado 7 pedidos en El Tambo.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SWAYP_HUANCAYO_DISTRICTS,
  deriveFenixCoverageCity,
  fenixWarehouseKey,
  isFenixCity,
  localityMismatch,
} from "@/lib/shipments";
import { UBIGEO_BY_CITY, resolveUbigeo, warehouseUbigeo } from "@/lib/ubigeo";
import { evaluateDirectFenixStock, type FenixStockRow } from "@/lib/fenix";
import { buildSwaypGuideInput, type SwaypSender } from "@/lib/swayp-guide";

const SWAYP_PANEL_JUNIN = [
  "Ahuac", "CHILCA", "CHUPURO", "CONCEPCIÓN", "EL TAMBO", "HUALHUAS", "HUAMANCACA CHICO", "HUANCAN",
  "HUANCAYO", "HUAYUCACHI", "INGENIO", "JAUJA", "MATAHUASI", "ORCOTUNA", "PILCOMAYO", "QUILCAS",
  "SAPALLANGA", "TRES DE DICIEMBRE", "VIQUES",
];

describe("la lista de Swayp en Junín resuelve a Huancayo", () => {
  it("son los 19 destinos de su panel, ni uno más", () => {
    expect(Object.keys(SWAYP_HUANCAYO_DISTRICTS)).toHaveLength(SWAYP_PANEL_JUNIN.length);
    for (const name of SWAYP_PANEL_JUNIN) {
      expect(deriveFenixCoverageCity(name, "Junín"), name).toBe("huancayo");
    }
  });

  it("#KP202768: «El Tambo, Junín» es Huancayo, con o sin tildes ni mayúsculas", () => {
    expect(deriveFenixCoverageCity("El Tambo", "Junín")).toBe("huancayo");
    expect(deriveFenixCoverageCity("EL TAMBO", "JUNIN")).toBe("huancayo");
    expect(deriveFenixCoverageCity("Huancán", "Junin")).toBe("huancayo");
    expect(isFenixCity(deriveFenixCoverageCity("El Tambo", "Junín"))).toBe(true);
  });

  it("también con su propia provincia al lado (la ubicación corregida trae la provincia)", () => {
    expect(deriveFenixCoverageCity("Matahuasi", "Concepción")).toBe("huancayo");
    expect(deriveFenixCoverageCity("Jauja", "Jauja")).toBe("huancayo");
    // Antes «Ahuac, Chupaca» caía a la satélite `chupaca`, sin remitente ni ubigeo.
    expect(deriveFenixCoverageCity("Ahuac", "Chupaca")).toBe("huancayo");
    expect(deriveFenixCoverageCity("El Tambo", "Huancayo")).toBe("huancayo");
  });

  it("sin Junín al lado no se adivina: «Chilca» también es de Cañete", () => {
    expect(deriveFenixCoverageCity("Chilca", "Lima")).toBe("lima");
    expect(deriveFenixCoverageCity("Chilca", "Cañete")).toBe("chilca");
    expect(deriveFenixCoverageCity("El Tambo", null)).toBe("el tambo");
    expect(deriveFenixCoverageCity("Matahuasi", "Huancavelica")).toBe("matahuasi");
  });

  it("lo que no está en la lista sigue como estaba", () => {
    expect(deriveFenixCoverageCity("Sicaya", "Junín")).toBe("sicaya");
    expect(deriveFenixCoverageCity("San Jerónimo de Tunán", "Junín")).toBe("san jeronimo de tunan");
    expect(deriveFenixCoverageCity("Tarma", "Junín")).toBe("tarma");
    expect(deriveFenixCoverageCity("Chupaca", "Junín")).toBe("chupaca");
    expect(deriveFenixCoverageCity("Yanacancha", "Chupaca")).toBe("chupaca");
    // Jauja entra como destino de la lista, no como ciudad ni almacén.
    expect(isFenixCity("Jauja")).toBe(false);
  });

  it("deja de marcar como contradictorio el «huancayo» que manda Aliclik para El Tambo", () => {
    expect(localityMismatch("huancayo", "El Tambo", "Junín")).toBe(false);
  });
});

describe("el stock y la guía salen de la bodega de Huancayo", () => {
  const stock: FenixStockRow[] = [{ city: "huancayo", product: "Cápsulas X", sku: "CX", quantity: 4 }];

  it("el stock es el de Huancayo", () => {
    expect(fenixWarehouseKey(deriveFenixCoverageCity("El Tambo", "Junín"))).toBe("huancayo");
    expect(evaluateDirectFenixStock(deriveFenixCoverageCity("El Tambo", "Junín"), stock, [{ title: "Cápsulas X", sku: "CX", quantity: 1 }]))
      .toEqual({ ok: true, city: "huancayo", uncovered: [] });
  });

  it("cada destino de la lista tiene su ubigeo exacto, y los de otras provincias el suyo, nunca el cercado", () => {
    for (const name of SWAYP_PANEL_JUNIN) {
      expect(resolveUbigeo("huancayo", name)?.exact, name).toBe(true);
    }
    expect(resolveUbigeo("huancayo", "El Tambo")?.code).toBe("120114");
    expect(resolveUbigeo("huancayo", "Concepción")?.code).toBe("120201");
    expect(resolveUbigeo("huancayo", "Matahuasi")?.code).toBe("120210");
    expect(resolveUbigeo("huancayo", "Orcotuna")?.code).toBe("120213");
    expect(resolveUbigeo("huancayo", "Jauja")?.code).toBe("120401");
    expect(resolveUbigeo("huancayo", "Ahuac")?.code).toBe("120902");
    expect(resolveUbigeo("huancayo", "Huamancaca Chico")?.code).toBe("120905");
    expect(resolveUbigeo("huancayo", "Tres de Diciembre")?.code).toBe("120908");
    // El de Chupaca no está en la lista de Swayp: no entra a la tabla.
    expect(UBIGEO_BY_CITY.huancayo!.chupaca).toBeUndefined();
    expect(warehouseUbigeo("huancayo")).toBe("120101");
  });

  it("la guía de #KP202768 sale de Huancayo hacia El Tambo", () => {
    const sender: SwaypSender = { nombre: "Kenku", nit: "20600000000", direccion: "Jr. Real 100", telefono: "959000000", email: "ventas@kenku.pe" };
    const r = buildSwaypGuideInput({
      city: deriveFenixCoverageCity("El Tambo", "Junín"),
      district: "El Tambo",
      customerName: "Cliente Ejemplo",
      customerPhone: "959111222",
      address1: "Av. Mariscal Castilla 1234",
      reference: null,
      lineItems: [{ title: "Cápsulas X", quantity: 1 }],
      codAmount: 149,
      senders: { huancayo: sender },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.ciudadRemitente).toBe("120101");
    expect(r.input.ciudadDestinatario).toBe("120114");
  });
});

describe("el MOM", () => {
  const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
  it("cuenta la regla, la lista, el caso y lo que cambió de Jauja", () => {
    expect(mom).toContain("**Junín sale de la bodega de Huancayo (07-11-2026, owner, #KP202768).**");
    expect(mom).toContain("«es a todos estos donde tiene cobertura swayp»");
    expect(mom).toContain(SWAYP_PANEL_JUNIN.slice(0, 3).join(", ").replace("CHILCA", "Chilca").replace("CHUPURO", "Chupuro"));
    expect(mom).toContain("Jauja, que la operación había descartado el 15-08-2026");
    expect(mom).toContain("«Chilca» también es un distrito de Cañete");
  });
});
