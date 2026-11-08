import { describe, expect, it } from "vitest";
import {
  priorHadFailure,
  recurringGpsCandidates,
  recurringGpsMismatch,
  type RecurringGpsPrior,
  type RecurringGpsShipment,
} from "@/lib/recurring-gps";

const order = { order_id: "now", address: "Jr. geranios A 1", district: "San Sebastián", province: "Cusco" };

const prior = (id: string, over: Partial<RecurringGpsPrior> = {}): RecurringGpsPrior => ({
  order_id: id,
  order_name: `#KP${id}`,
  order_created_at: "2026-08-30T12:00:00Z",
  general_status: "entregado",
  dispatched_at: "2026-09-01T20:00:00Z",
  attempt_count: 0,
  delivered_at: "2026-09-02T18:00:00Z",
  address: "Jr. Geranios A-1",
  district: "San Sebastian",
  province: "Cusco",
  ...over,
});

const guide = (orderId: string, over: Partial<RecurringGpsShipment> = {}): RecurringGpsShipment => ({
  order_id: orderId,
  courier: "aliclik",
  delivery_status: "entregado",
  latitude: -13.5338163,
  longitude: -71.9256485,
  closed_at: "2026-09-02T18:00:00Z",
  returned_at: null,
  reported_status: "DELIVERED · CONFIRMED",
  created_at: "2026-09-01T17:23:06Z",
  ...over,
});

describe("los candidatos de «Usar este GPS»", () => {
  it("#KP131756: entregado con GPS de Aliclik, en la misma casa, sin aviso", () => {
    const [c, ...rest] = recurringGpsCandidates({ order, priors: [prior("131756")], shipments: [guide("131756")] });
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      orderId: "131756",
      orderName: "#KP131756",
      deliveredLabel: "02-09",
      lat: -13.5338163,
      lng: -71.9256485,
      coordinate: "-13.5338163, -71.9256485",
      addressDiffers: false,
      districtDiffers: false,
      warning: null,
    });
  });

  it("el más reciente primero, hasta tres", () => {
    const ids = ["1", "2", "3", "4"];
    const priors = ids.map((id, i) => prior(id, { delivered_at: `2026-09-0${i + 1}T18:00:00Z` }));
    const out = recurringGpsCandidates({ order, priors, shipments: ids.map((id) => guide(id)) });
    expect(out.map((c) => c.orderId)).toEqual(["4", "3", "2"]);
  });

  it("solo entregados: lo que no se entregó no cuenta", () => {
    const out = recurringGpsCandidates({
      order,
      priors: [prior("a", { general_status: "en_ruta" }), prior("b", { general_status: "devuelto" })],
      shipments: [guide("a", { delivery_status: "en_ruta" }), guide("b", { delivery_status: "devuelto" })],
    });
    expect(out).toEqual([]);
  });

  it("fuera el pedido con un fallido: intento no entregado, devuelta o rechazo en la puerta", () => {
    const out = recurringGpsCandidates({
      order,
      priors: [prior("intento", { attempt_count: 1 }), prior("vuelta"), prior("puerta"), prior("limpio")],
      shipments: [
        guide("intento"),
        guide("vuelta"),
        guide("vuelta", { delivery_status: "devuelto", returned_at: "2026-08-20T00:00:00Z" }),
        guide("puerta"),
        guide("puerta", { delivery_status: "anulado", reported_status: "REFUSED · CANCEL" }),
        guide("limpio"),
      ],
    });
    expect(out.map((c) => c.orderId)).toEqual(["limpio"]);
  });

  it("sin GPS en su guía Aliclik entregada, no se propone", () => {
    const out = recurringGpsCandidates({
      order,
      priors: [prior("sin"), prior("otro"), prior("cero")],
      shipments: [
        guide("sin", { latitude: null, longitude: null }),
        guide("otro", { courier: "shalom" }),
        guide("cero", { latitude: 0, longitude: 0 }),
      ],
    });
    expect(out).toEqual([]);
  });

  it("el propio pedido no es candidato", () => {
    expect(recurringGpsCandidates({ order, priors: [prior("now")], shipments: [guide("now")] })).toEqual([]);
  });

  it("otra dirección u otro distrito: aviso ámbar", () => {
    const out = recurringGpsCandidates({
      order,
      priors: [
        prior("dir", { address: "Av. de la Cultura 1200" }),
        prior("dist", { district: "Wanchaq", delivered_at: "2026-09-01T00:00:00Z" }),
      ],
      shipments: [guide("dir"), guide("dist")],
    });
    expect(out[0]).toMatchObject({ orderId: "dir", addressDiffers: true, districtDiffers: false });
    expect(out[0]!.warning).toBe("La dirección no es la de este pedido: confirma con la clienta que recibe ahí.");
    expect(out[1]).toMatchObject({ orderId: "dist", addressDiffers: false, districtDiffers: true });
    expect(out[1]!.warning).toBe("Otro distrito (Wanchaq): confirma con la clienta que recibe ahí.");
  });
});

describe("el aviso y el fallido", () => {
  it("las dos cosas a la vez", () => {
    expect(recurringGpsMismatch({ addressDiffers: true, districtDiffers: true, district: "Wanchaq" })).toBe(
      "Otra dirección y otro distrito (Wanchaq): confirma con la clienta que recibe ahí.",
    );
    expect(recurringGpsMismatch({ addressDiffers: false, districtDiffers: false, district: null })).toBeNull();
  });

  it("un anulado después de salir es fallido; uno limpio no", () => {
    expect(priorHadFailure(prior("x", { general_status: "anulado" }), [])).toBe(true);
    expect(priorHadFailure(prior("x"), [guide("x")])).toBe(false);
  });
});
