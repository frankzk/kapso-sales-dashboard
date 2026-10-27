import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTOECOM_MISSING_WARNING, AUTOECOM_ONLY_REASON, isAutoecom, limaTransportPolicy } from "@/lib/aliclik-lima";
import { TANDERS_NEW_GUIDES_ENABLED, TANDERS_NEW_GUIDES_OFF_MESSAGE } from "@/lib/tanders/new-guides";
import { REPRO_COURIER_CHOICES, REPRO_COURIER_LABEL, isReproCourier } from "@/lib/repro-lima";

/**
 * Aliclik en Lima, solo con AUTOECOM, y Tanders sin guías nuevas (MOM §9,
 * «Aliclik en Lima», 26-10-2026, decisión del owner).
 */

const read = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");

type Quote = { transportName?: string | null; selectable: boolean; reason?: string; transportId: number };

describe("isAutoecom: el nombre que dé Aliclik", () => {
  it("sin espacios, guiones ni mayúsculas", () => {
    // «AutoEcom Logistic»: el nombre que Aliclik le da (confirmado el 26-10-2026).
    for (const name of ["AutoEcom Logistic", "AUTOECOM", "Auto Ecom", "AUTO-ECOM", "autoecom express"]) expect(isAutoecom(name), name).toBe(true);
    for (const name of ["ALIDRIVER", "ECOM", "", null, undefined]) expect(isAutoecom(name), String(name)).toBe(false);
  });
});

describe("limaTransportPolicy: qué transporte se puede elegir en Lima", () => {
  const alidriver: Quote = { transportId: 1, transportName: "ALIDRIVER", selectable: true };
  const autoecom: Quote = { transportId: 7, transportName: "AUTOECOM", selectable: true };

  it("con AUTOECOM en la cotización, solo AUTOECOM", () => {
    const { couriers, warning } = limaTransportPolicy([alidriver, autoecom]);
    expect(couriers.find((c) => c.transportId === 7)).toMatchObject({ selectable: true });
    expect(couriers.find((c) => c.transportId === 1)).toMatchObject({ selectable: false, reason: AUTOECOM_ONLY_REASON });
    expect(warning).toBeNull();
  });

  it("sin AUTOECOM, el que Aliclik ofrezca, con el aviso (decisión del owner)", () => {
    const { couriers, warning } = limaTransportPolicy([alidriver]);
    expect(couriers).toEqual([alidriver]);
    expect(warning).toBe(AUTOECOM_MISSING_WARNING);
  });

  it("un AUTOECOM express fuera de hora sigue sin poderse elegir", () => {
    const fueraDeHora: Quote = { ...autoecom, selectable: false, reason: "Express disponible solo entre 05:01 y 14:00" };
    const { couriers } = limaTransportPolicy([fueraDeHora, alidriver]);
    expect(couriers.every((c) => !c.selectable)).toBe(true);
  });

  it("la cotización la aplica solo en Lima, y crear la guía exige `selectable`", () => {
    const src = read("lib/aliclik-guide.ts");
    expect(src).toContain('classifyOperation(ctx.row) === "lima" ? limaTransportPolicy(quoted) : null');
    expect(src).toContain("if (!courier.selectable)");
  });
});

describe("Tanders ya no crea guías nuevas", () => {
  it("la acción responde con el motivo antes de llamar a Tanders", () => {
    expect(TANDERS_NEW_GUIDES_ENABLED).toBe(false);
    expect(TANDERS_NEW_GUIDES_OFF_MESSAGE).toContain("Tanders ya no crea guías nuevas");
    const src = read("app/dashboard/pedidos/tanders-actions.ts");
    const gate = src.indexOf("if (!TANDERS_NEW_GUIDES_ENABLED) return { error: TANDERS_NEW_GUIDES_OFF_MESSAGE };");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(src.indexOf("client.createOrder(built.payload)"));
  });
});

describe("Repro Lima acuerda con Aliclik en lugar de Tanders", () => {
  it("la hoja ofrece Aliclik y ya no Tanders; los acuerdos viejos con Tanders se siguen leyendo", () => {
    expect(REPRO_COURIER_CHOICES).toContain("aliclik");
    expect(REPRO_COURIER_CHOICES).not.toContain("tanders");
    expect(REPRO_COURIER_LABEL.aliclik).toBe("Aliclik");
    expect(isReproCourier("tanders")).toBe(true);
  });

  it("la 0283 admite Aliclik en los dos CHECK", () => {
    const sql = read("db/migrations/0283_lima_repro_aliclik.sql");
    expect(sql).toContain("check (agreed_courier in ('propio', 'aliclik', 'tanders', 'fenix', 'urpi', 'axel'))");
    expect(sql).toContain("check (courier in ('propio', 'aliclik', 'tanders', 'fenix', 'urpi', 'axel'))");
  });
});

describe("el MOM", () => {
  it("lo cuenta", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toContain("#### Aliclik en Lima, solo con AUTOECOM, y Tanders sin guías nuevas (26-10-2026)");
    expect(mom).toContain("`limaTransportPolicy`");
  });
});
