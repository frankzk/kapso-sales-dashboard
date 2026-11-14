// Repro Lima reconoce la salida viva de cualquier courier y la caja en oficina
// (owner, 13-11-2026: «cablea todas las conexiones para que no vuelva a
// suceder»; #KP205892, #KP205878).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agreementState,
  agreementStateLabel,
  boxLocation,
  boxLocationLabel,
  isOwnBox,
  isProblemState,
  liveOutputsOf,
  materializationPlan,
  type BoxLocation,
} from "@/lib/repro-lima";
import { retryGroup } from "@/lib/warehouse-retries";

const none = new Set<string>();
const out = (o: Partial<{ id: string; courier: string; delivery_status: string; custody_state: string | null; custody_transferred_at: string | null; returned_at: string | null; output_number: number; dispatched_at: string | null; status_category: string | null; reported_status: string | null; swayp_state: number | null }>) =>
  ({ id: "s1", courier: "fenix", delivery_status: "en_ruta", custody_state: "empresa", custody_transferred_at: null, returned_at: null, output_number: 1, dispatched_at: null, status_category: "pending", reported_status: null, swayp_state: 1, ...o });
const agreement = (courier: string) => ({ agreed_on: "2026-11-14", agreed_courier: courier, box_action: "salida_nueva_rearmar", materialized_at: null, materialized_on: null });
const base = { ownLive: null, box: null, lastFailed: null, receivedAt: null };

describe("salidas vivas", () => {
  it("la salida de Swayp rellenada desde la Mesa de ruta es la salida viva de otro courier", () => {
    const live = liveOutputsOf([out({})], none);
    expect(live.other?.courier).toBe("fenix");
    expect(live.tbdInOffice).toBeNull();
  });
  it("una «por definir» armada en la empresa consta en oficina; devuelta o transferida, no", () => {
    expect(liveOutputsOf([out({ courier: "por_definir", delivery_status: "pendiente" })], none).tbdInOffice).not.toBeNull();
    expect(liveOutputsOf([out({ courier: "propio", delivery_status: "pendiente", custody_state: "devuelto" })], none).tbdInOffice).toBeNull();
    expect(liveOutputsOf([out({ courier: "propio", delivery_status: "pendiente", custody_state: "courier", custody_transferred_at: "2026-11-13T10:00:00Z" })], none).tbdInOffice).toBeNull();
  });
  it("la guía que ya falló no es la salida viva", () => {
    const failed = out({ courier: "aliclik", delivery_status: "anulado", status_category: "failed", dispatched_at: "2026-11-10T10:00:00Z" });
    expect(liveOutputsOf([failed], none).other).toBeNull();
  });
});

describe("dónde está la caja", () => {
  it("con la salida de otro courier: en oficina o la lleva el courier", () => {
    const office = boxLocation({ ...base, liveOther: { courier: "fenix", custody_state: "empresa" } });
    expect(office).toEqual({ kind: "con_courier", courier: "fenix", enOficina: true });
    expect(boxLocationLabel(office)).toContain("en oficina");
    const out = boxLocation({ ...base, liveOther: { courier: "aliclik", custody_state: "courier", custody_transferred_at: "x" } });
    expect(out).toMatchObject({ kind: "con_courier", enOficina: false });
    expect(boxLocationLabel(out)).toBe("La lleva Aliclik");
    expect(isOwnBox(out)).toBe(false);
  });
  it("un pendiente que nunca salió, con su caja en la empresa, ya no es «No consta»", () => {
    const box = boxLocation({ ...base, liveInOffice: { dispatched_at: null } });
    expect(box).toMatchObject({ kind: "en_oficina", courier: null, nuncaSalio: true });
    expect(boxLocationLabel(box)).toBe("En oficina");
    expect(isOwnBox(box)).toBe(true);
    expect(boxLocation(base)).toEqual({ kind: "desconocida" });
  });
});

describe("el acuerdo frente a la salida", () => {
  const swayp: BoxLocation = { kind: "con_courier", courier: "fenix", enOficina: true };
  const state = (courier: string, box: BoxLocation) =>
    agreementState({ c: agreement(courier), program: null, box, plan: materializationPlan({ courier: courier as never, boxAction: "salida_nueva_rearmar", box, retryAdmission: false }), today: "2026-11-13" });
  it("acordado con Swayp y la salida de Swayp ya existe: «Salida creada», no pide nada", () => {
    const s = state("fenix", swayp);
    expect(s.kind).toBe("salida_creada");
    expect(isProblemState(s.kind)).toBe(false);
    expect(agreementStateLabel(s, agreement("fenix"))).toMatch(/^Salida creada · sale .* con Swayp$/);
  });
  it("acordado con otro courier (o con Grupo GF): «revisa cuál sale», es problema", () => {
    for (const courier of ["aliclik", "propio"]) {
      const s = state(courier, swayp);
      expect(s).toEqual({ kind: "salida_distinta", courier: "fenix" });
      expect(isProblemState(s.kind)).toBe(true);
      expect(agreementStateLabel(s, agreement(courier))).toContain("Ya tiene salida con Swayp");
    }
  });
  it("sin salida todavía sigue pidiendo crearla en la Mesa de ruta", () => {
    const s = state("fenix", { kind: "desconocida" });
    expect(s.kind).toBe("otro_courier");
  });
  it("Grupo GF no programa una caja que ya trabaja otro courier", () => {
    expect(materializationPlan({ courier: "propio", boxAction: "mantener", box: swayp, retryAdmission: false })).toEqual({ no: "otro_courier" });
  });
});

describe("Almacén y la base", () => {
  it("la salida ya entregada al courier va a «Todavía fuera»", () => {
    const facts = { critical: false, unconfirmed: false, defaultProblem: false, noReception: false, addressDrift: false, otherSalidaExists: false, state: "salida_creada" as const };
    expect(retryGroup({ ...facts, box: { kind: "con_courier", courier: "fenix", enOficina: false } } as never)).toBe("fuera");
    expect(retryGroup({ ...facts, state: "salida_distinta", box: { kind: "con_courier", courier: "fenix", enOficina: true } } as never)).toBe("con_aviso");
  });
  it("la caja que nunca salió no pide recepción; la base admite «con_courier»", () => {
    expect(readFileSync("lib/warehouse-retries.ts", "utf8")).toContain("!r.box.nuncaSalio");
    const sql = readFileSync("db/migrations/0339_repro_box_con_courier.sql", "utf8");
    expect(sql).toContain("'con_courier'::text");
    expect(readFileSync("db/apply.sql", "utf8")).toContain("0339_repro_box_con_courier");
  });
});
