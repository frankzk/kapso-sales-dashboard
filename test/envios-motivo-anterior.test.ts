import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { motivoDelCourier } from "@/lib/aliclik-status";

/**
 * MOM §11.7: el motivo anterior se ve antes de llamar, y su ausencia también.
 *
 * `reported_status` estaba en la fila, tipada y usada por la elegibilidad de
 * recuperación, y no se pintaba en ninguna pantalla: la asesora llamaba sin
 * saber si la clienta ya había visto el producto y lo había rechazado en la
 * puerta, que es justo lo que el MOM manda revisar antes de reenviar.
 */

const ui = readFileSync(resolve(process.cwd(), "components/shipments.tsx"), "utf8");
const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");

describe("la lectura del motivo, pura", () => {
  it("un rechazo en la puerta consta, y se marca como que vio el producto", () => {
    const m = motivoDelCourier("REFUSED · RETURNED");
    expect(m.consta).toBe(true);
    expect(m.vioElProducto).toBe(true);
    expect(m.texto).toBe("lo rechazó en la puerta · devuelto al almacén");
  });

  it("no contestar al motorizado no es haber visto el producto", () => {
    const m = motivoDelCourier("NOT_RESPOND · IN_TRANSIT");
    expect(m.consta).toBe(true);
    expect(m.vioElProducto).toBe(false);
    expect(m.texto).toContain("no contestó al motorizado");
  });

  it("sin dato NO va un guion: la ausencia se escribe", () => {
    for (const vacio of [null, undefined, "", "   "]) {
      const m = motivoDelCourier(vacio);
      expect(m.consta).toBe(false);
      expect(m.vioElProducto).toBe(false);
      expect(m.texto).toBe("sin motivo del courier · no consta si la rechazó en la puerta");
    }
  });

  it("una etiqueta que no sabemos leer se muestra cruda, no se inventa", () => {
    const m = motivoDelCourier("ALGO_NUEVO · OTRA_COSA");
    expect(m.consta).toBe(true);
    expect(m.vioElProducto).toBe(false);
    expect(m.texto).toBe("ALGO_NUEVO · OTRA_COSA");
  });
});

describe("dónde se ve", () => {
  it("la cola trae una columna de motivo en lugar de producto", () => {
    expect(ui).toContain('label="Motivo anterior" sortKey="reason"');
    expect(ui).not.toContain('label="Producto" sortKey="product"');
  });

  it("la ficha que se lee mientras suena el teléfono también lo trae", () => {
    expect(ui).toContain("Cómo terminó el intento anterior");
    expect(ui).toContain("Vio el producto y no quedó: normalmente no se reenvía.");
  });

  it("la tarjeta de teléfono recuperó pedido y tienda", () => {
    // Existían solo en la tabla: en el celular no había forma de saber de qué
    // pedido se hablaba ni, con varias tiendas, de cuál era.
    const card = ui.slice(ui.indexOf("<ul className=\"divide-y divide-slate-100 md:hidden\">"));
    expect(card.slice(0, 3000)).toContain("<OrderNameLabel name={s.order_name} matched={s.matched} />");
    expect(card.slice(0, 3000)).toContain("storeName(s.store_id)");
  });
});

describe("el MOM lo dice", () => {
  it("§11.7 nombra la regla y la ausencia", () => {
    expect(mom).toContain("### 11.7 El motivo anterior se ve antes de llamar, y su ausencia también");
    // El MOM va a 80 columnas, así que la frase se parte: se compara sin saltos.
    expect(mom.replace(/\s+/g, " ")).toContain(
      "sin motivo del courier · no consta si la rechazó en la puerta",
    );
  });
});
