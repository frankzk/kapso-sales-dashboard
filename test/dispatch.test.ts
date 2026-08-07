import { describe, expect, it } from "vitest";
import {
  deriveDispatchManifestState,
  dispatchProgress,
  normalizeDispatchScan,
  pickDispatchScanTarget,
  type DispatchScanCandidate,
} from "@/lib/dispatch";

describe("dispatchProgress", () => {
  it("ignora paquetes retirados expresamente", () => {
    expect(
      dispatchProgress([
        { office_checked_at: "2026-07-31", pickup_checked_at: "2026-07-31" },
        { office_checked_at: null, pickup_checked_at: null, removed_at: "2026-07-31" },
      ]),
    ).toMatchObject({ total: 1, officeChecked: 1, pickupChecked: 1, pickupComplete: true });
  });
});

describe("deriveDispatchManifestState", () => {
  it("no declara lista una ruta incompleta", () => {
    expect(
      deriveDispatchManifestState(
        [{ office_checked_at: "2026-07-31" }, { office_checked_at: null }],
        "office_check",
      ),
    ).toBe("office_check");
  });

  it("espera la confirmación atómica antes de transferir custodia", () => {
    const items = [{ office_checked_at: "2026-07-31", pickup_checked_at: "2026-07-31" }];
    expect(deriveDispatchManifestState(items, "pickup_check")).toBe("pickup_check");
    expect(deriveDispatchManifestState(items, "in_custody")).toBe("in_custody");
  });
});

describe("normalizeDispatchScan", () => {
  it("acepta token, URL y código con numeral", () => {
    expect(normalizeDispatchScan("  KP123-S02  ")).toBe("KP123-S02");
    expect(normalizeDispatchScan("#KP123")).toBe("KP123");
    expect(normalizeDispatchScan("https://kapta.pe/s/abc-123")).toBe("abc-123");
    expect(normalizeDispatchScan("https://kapta.pe/s?qr=token-9")).toBe("token-9");
  });
});


describe("pickDispatchScanTarget", () => {
  const salida = (id: string, overrides: Partial<DispatchScanCandidate> = {}): DispatchScanCandidate => ({
    id,
    custody_state: "empresa",
    preparation_state: "rotulo_generado",
    output_code: `KP1-${id}`,
    guide_code: `G-${id}`,
    ...overrides,
  });
  const pendiente = (c: DispatchScanCandidate) =>
    c.custody_state === "empresa" && c.preparation_state !== "listo_despacho";

  it("no encuentra nada cuando el escaneo no designa salidas", () => {
    expect(pickDispatchScanTarget([])).toEqual({ kind: "ninguna" });
  });

  it("resuelve el pedido de una sola salida", () => {
    const uno = salida("S01");
    expect(pickDispatchScanTarget([uno], pendiente)).toEqual({ kind: "unica", shipment: uno });
  });

  it("elige la salida que falta armar cuando el pedido ya tiene otra lista", () => {
    const lista = salida("S01", { preparation_state: "listo_despacho" });
    const porArmar = salida("S02");
    expect(pickDispatchScanTarget([lista, porArmar], pendiente)).toEqual({
      kind: "unica",
      shipment: porArmar,
    });
  });

  it("no adivina entre dos salidas pendientes del mismo pedido", () => {
    const options = [salida("S01"), salida("S02")];
    expect(pickDispatchScanTarget(options, pendiente)).toEqual({ kind: "ambigua", options });
  });

  it("devuelve la salida ya armada para que el llamador avise, en vez de perderla", () => {
    const lista = salida("S01", { preparation_state: "listo_despacho" });
    expect(pickDispatchScanTarget([lista], pendiente)).toEqual({ kind: "unica", shipment: lista });
  });

  it("ignora lo que ya salió de custodia si queda una salida en casa", () => {
    const despachada = salida("S01", { custody_state: "courier" });
    const enCasa = salida("S02");
    expect(pickDispatchScanTarget([despachada, enCasa], pendiente)).toEqual({
      kind: "unica",
      shipment: enCasa,
    });
  });

  it("prefiere la salida que pertenece a la ruta al cotejar", () => {
    const fuera = salida("S01");
    const enRuta = salida("S02");
    expect(pickDispatchScanTarget([fuera, enRuta], (c) => c.id === "S02")).toEqual({
      kind: "unica",
      shipment: enRuta,
    });
  });
});
