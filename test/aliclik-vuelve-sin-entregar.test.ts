import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aliclikVuelveSinEntregar, puertaDeSalidaAdicional, salidasQueEstorban } from "@/lib/shipment-output";

/**
 * #KP143415 (04-11-2026): AUR5X866423366918 dice `NOT_RESPOND · TO_RETURN` desde el
 * 29-10 y seguía `pendiente` en Kapta, así que la Swayp directa respondía «fuera
 * de Lima hay que gestionarla o anularla» — y una guía en la calle no se anula.
 * Medido desde el 01-09: 723 guías llegaron a TO_RETURN con intento fallido y
 * nunca con PENDING_DELIVERY; se entregó una. `PENDING_DELIVERY · TO_RETURN`, en
 * cambio, se entregó 650 de 1.954 veces.
 */

const aliclik = (reported_status: string, delivery_status = "pendiente") => ({
  courier: "aliclik", delivery_status, reported_status, output_code: "KP143415-S01", custody_state: "courier",
});

describe("aliclikVuelveSinEntregar", () => {
  it("intento fallido + TO_RETURN: ya vuelve, no se va a entregar", () => {
    for (const s of ["NOT_RESPOND", "REFUSED", "CANCEL", "ANNULLED"]) {
      expect(aliclikVuelveSinEntregar(aliclik(`${s} · TO_RETURN · CONFIRMED`)), s).toBe(true);
    }
  });

  it("PENDING_DELIVERY · TO_RETURN NO: un tercio se entrega", () => {
    expect(aliclikVuelveSinEntregar(aliclik("PENDING_DELIVERY · TO_RETURN · CONFIRMED"))).toBe(false);
  });

  it("RESCHEDULED no: la clienta pidió otra fecha", () => {
    expect(aliclikVuelveSinEntregar(aliclik("RESCHEDULED · TO_RETURN · CONFIRMED"))).toBe(false);
  });

  it("el intento fallido sin TO_RETURN no: el motorizado puede volver a salir", () => {
    expect(aliclikVuelveSinEntregar(aliclik("NOT_RESPOND · PICKED · CONFIRMED"))).toBe(false);
  });

  it("solo Aliclik, y sin etiqueta no se adivina", () => {
    expect(aliclikVuelveSinEntregar({ courier: "tanders", reported_status: "NOT_RESPOND · TO_RETURN" })).toBe(false);
    expect(aliclikVuelveSinEntregar({ courier: "aliclik", reported_status: null })).toBe(false);
  });
});

describe("la puerta de salida adicional fuera de Lima", () => {
  it("el caso: la Aliclik que vuelve ya no bloquea la Swayp directa", () => {
    const outputs = [aliclik("NOT_RESPOND · TO_RETURN · CONFIRMED")];
    expect(salidasQueEstorban(outputs)).toEqual([]);
    expect(puertaDeSalidaAdicional({ courier: "fenix", operation: "provincia_cod", outputs, motivo: null }).ok).toBe(true);
  });

  it("una Aliclik que todavía puede entregar sigue bloqueando", () => {
    for (const label of ["PENDING_DELIVERY · TO_RETURN · CONFIRMED", "PENDING_DELIVERY · PICKED · CONFIRMED", "NOT_RESPOND · PICKED · CONFIRMED"]) {
      const r = puertaDeSalidaAdicional({ courier: "fenix", operation: "provincia_cod", outputs: [aliclik(label)], motivo: null });
      expect(r.ok, label).toBe(false);
    }
  });

  it("la Swayp directa lee la etiqueta: sin ella la regla no vería nada", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/swayp-directa.ts"), "utf8");
    expect(src).toContain("output_number,output_code,reported_status");
  });

  it("el MOM lo dice", () => {
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8").replace(/\s+/g, " ");
    expect(mom).toContain("Una guía Aliclik que ya vuelve sin entregar no bloquea otra salida (04-11-2026)");
  });
});
