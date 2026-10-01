import { describe, expect, it } from "vitest";
import {
  addressQuery,
  addressToCopy,
  firstName,
  navigationHref,
  riderWhatsappMessage,
  soles,
  telHref,
  wazeHref,
  whatsappHref,
  whatsappNumber,
} from "@/lib/rider-contact";

// Los atajos del motorizado en la calle (30-09-2026): ir con Maps o Waze,
// escribir por WhatsApp como la tienda y llamar.

describe("número para WhatsApp", () => {
  it("un celular peruano sin código recibe el 51", () => {
    expect(whatsappNumber("987654321")).toBe("51987654321");
    expect(whatsappNumber("987 654 321")).toBe("51987654321");
  });

  it("con el código escrito de cualquier forma queda igual", () => {
    expect(whatsappNumber("+51 912 345 678")).toBe("51912345678");
    expect(whatsappNumber("0051912345678")).toBe("51912345678");
    expect(whatsappNumber("51-912-345-678")).toBe("51912345678");
  });

  it("un fijo o un número incompleto no tiene WhatsApp", () => {
    expect(whatsappNumber("014567890")).toBeNull();
    expect(whatsappNumber("5114567890")).toBeNull();
    expect(whatsappNumber("98765")).toBeNull();
    expect(whatsappNumber("")).toBeNull();
    expect(whatsappNumber(null)).toBeNull();
  });

  it("un número de otro país con su código se respeta", () => {
    expect(whatsappNumber("+34 612 345 678")).toBe("34612345678");
  });
});

describe("llamar", () => {
  it("con número internacional si es celular, y el fijo tal cual", () => {
    expect(telHref("987654321")).toBe("tel:+51987654321");
    expect(telHref("014567890")).toBe("tel:014567890");
    expect(telHref("")).toBeNull();
  });
});

describe("mensaje de WhatsApp como la tienda", () => {
  const base = { customerName: "ABRAHAM ureña torres", riderName: "Roy", storeName: "Kenku Peru", orderName: "#KP136779", amountDue: 298 };

  it("voy en camino: se presenta como la tienda y dice cuánto pagar", () => {
    const text = riderWhatsappMessage("en_camino", base);
    expect(text).toBe("Hola Abraham, soy Roy, el motorizado de Kenku Peru. Voy en camino con tu pedido #KP136779. El monto a pagar es S/ 298.00.");
  });

  it("ya llegué: el mismo saludo con la llegada", () => {
    expect(riderWhatsappMessage("llegue", base)).toContain("Ya llegué con tu pedido #KP136779, estoy afuera.");
  });

  it("pagado antes: no pide dinero; sin saldo conocido, no menciona monto", () => {
    expect(riderWhatsappMessage("en_camino", { ...base, amountDue: 0 })).toMatch(/Tu pedido ya está pagado\.$/);
    expect(riderWhatsappMessage("en_camino", { ...base, amountDue: null })).toMatch(/#KP136779\.$/);
  });

  it("sin nombres no inventa nada", () => {
    expect(riderWhatsappMessage("en_camino", { customerName: null, riderName: null, storeName: null, orderName: null, amountDue: null }))
      .toBe("Hola, soy tu motorizado. Voy en camino con tu pedido.");
    expect(riderWhatsappMessage("en_camino", { ...base, storeName: null })).toContain("soy Roy, tu motorizado.");
  });

  it("el enlace lleva el texto codificado y solo si hay celular", () => {
    const href = whatsappHref("987654321", "Hola Abraham, ¿todo bien?");
    expect(href).toBe("https://wa.me/51987654321?text=Hola%20Abraham%2C%20%C2%BFtodo%20bien%3F");
    expect(whatsappHref("987654321")).toBe("https://wa.me/51987654321");
    expect(whatsappHref("014567890", "hola")).toBeNull();
  });
});

describe("ir a la parada", () => {
  const withCoords = { address: "Av. Benavides 4550", district: "Santiago de Surco", province: "Lima", latitude: -12.13, longitude: -76.99 };
  const noCoords = { address: "Jr. Los Pinos 123", district: "La Molina", province: "Lima", latitude: null, longitude: null };

  it("Google Maps en modo navegación, por coordenadas si las hay", () => {
    expect(navigationHref(withCoords)).toBe("https://www.google.com/maps/dir/?api=1&destination=-12.13%2C-76.99&dir_action=navigate");
  });

  it("sin coordenadas, por la dirección escrita con el país", () => {
    expect(addressQuery(noCoords)).toBe("Jr. Los Pinos 123, La Molina, Lima, Perú");
    expect(navigationHref(noCoords)).toBe(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("Jr. Los Pinos 123, La Molina, Lima, Perú")}&dir_action=navigate`);
  });

  it("no fija el modo de viaje: Maps usa el del motorizado", () => {
    expect(navigationHref(withCoords)).not.toContain("travelmode");
  });

  it("Waze igual, y nada sin dirección", () => {
    expect(wazeHref(withCoords)).toBe("https://waze.com/ul?ll=-12.13,-76.99&navigate=yes");
    expect(wazeHref(noCoords)).toContain("https://waze.com/ul?q=");
    expect(navigationHref({})).toBeNull();
    expect(wazeHref(null)).toBeNull();
  });

  it("copiar deja la dirección y la referencia en otra línea", () => {
    expect(addressToCopy({ ...noCoords, reference: "Casa verde" })).toBe("Jr. Los Pinos 123, La Molina\nRef: Casa verde");
    expect(addressToCopy({})).toBeNull();
  });
});

describe("formato", () => {
  it("nombre de pila con mayúscula inicial", () => {
    expect(firstName("ABRAHAM ureña")).toBe("Abraham");
    expect(firstName("  lucia chavez")).toBe("Lucia");
    expect(firstName("")).toBeNull();
  });

  it("soles con miles y dos decimales", () => {
    expect(soles(1298)).toBe("S/ 1,298.00");
    expect(soles(59)).toBe("S/ 59.00");
  });
});
