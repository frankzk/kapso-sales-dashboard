// Tarifa personal del motorizado por distrito (0162), vista desde el Tarifario.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkStopRate, resolveRiderRate, stopEarnings, stopEarns, type RiderPayRate, type RiderRateVersion } from "@/lib/rider-pay";

const v = (district_key: string | null, amount: number, effective_from: string, created_at = `${effective_from}T10:00:00Z`): RiderRateVersion => ({ district_key, amount, effective_from, created_at });

describe("resolveRiderRate", () => {
  const rates = [v(null, 8.5, "2026-09-01"), v("surco", 10, "2026-09-10"), v("surco", 11, "2026-09-20"), v(null, 9, "2026-09-25")];
  it("la del distrito gana a la general, y cuenta la vigencia", () => {
    expect(resolveRiderRate(rates, "surco", "2026-09-22")).toEqual({ amount: 11, source: "distrito", effectiveFrom: "2026-09-20" });
    expect(resolveRiderRate(rates, "surco", "2026-09-15")).toMatchObject({ amount: 10 });
    expect(resolveRiderRate(rates, "surco", "2026-09-05")).toMatchObject({ amount: 8.5, source: "general" });
  });
  it("sin tarifa de distrito usa la general vigente; sin nada, null", () => {
    expect(resolveRiderRate(rates, "ate", "2026-09-22")).toMatchObject({ amount: 8.5, source: "general" });
    expect(resolveRiderRate(rates, "ate", "2026-09-26")).toMatchObject({ amount: 9 });
    expect(resolveRiderRate(rates, "ate", "2026-08-01")).toBeNull();
  });
  it("a igual vigencia, la última registrada", () => {
    expect(resolveRiderRate([v("ate", 7, "2026-09-01", "2026-09-01T10:00:00Z"), v("ate", 7.5, "2026-09-01", "2026-09-02T10:00:00Z")], "ate", "2026-09-22")).toMatchObject({ amount: 7.5 });
  });
});

describe("checkStopRate: la tarifa de la parada frente a las registradas", () => {
  const rate = (district_key: string | null, amount: number, effective_from = "2026-09-01"): RiderPayRate => ({ id: `${district_key}:${amount}`, district_key, amount, effective_from, reason: "x", created_at: `${effective_from}T10:00:00Z` });
  const rates = [rate(null, 8.5), rate("san isidro", 10, "2026-09-22")];
  it("cuadra: la general donde no hay del distrito", () => {
    expect(checkStopRate({ district: "Lince", configured_rate: 8.5 }, rates, "2026-09-22")).toEqual({ source: "general", current: 8.5, warning: null });
  });
  it("avisa si hoy rige una tarifa del distrito distinta a la calculada o aprobada", () => {
    const check = checkStopRate({ district: "San Isidro", configured_rate: 8.5 }, rates, "2026-09-22");
    expect(check.source).toBe("distrito");
    expect(check.warning).toBe("Con las tarifas de hoy sería S/ 10.00 (tarifa del distrito).");
  });
  it("avisa si el distrito del pedido no se reconoce", () => {
    expect(checkStopRate({ district: "Pucallpa", configured_rate: 8.5 }, rates, "2026-09-22").warning).toBe("Distrito «Pucallpa» no reconocido: se aplica la tarifa general.");
    // «LIMA» a secas es el Cercado: sí se reconoce.
    expect(checkStopRate({ district: "LIMA", configured_rate: 8.5 }, rates, "2026-09-22").warning).toBeNull();
  });
});

// Yhoni, 28/09: la columna «Ganancia» decía «Sin tarifa» también en los «no
// estaba» y «no contesta», que no se pagan con o sin tarifa. Con la tarifa
// puesta habrían dicho «Tarifa S/ 0.00». Ahora dicen «No se paga».
describe("stopEarnings: qué dice la ganancia de una parada", () => {
  const conTarifa = { configured_rate: 8.5, base: 8.5 };
  const sinTarifa = { configured_rate: null, base: null };
  const parada = (status: string, outcome_reason: string | null = null) => ({ status, outcome_reason });

  it("solo la entrega y el rechazo se pagan", () => {
    expect(stopEarns(parada("entregado"))).toBe(true);
    expect(stopEarns(parada("no_entregado", "rechazado"))).toBe(true);
    for (const motivo of ["no_contesta", "no_estaba", "reprogramado", "direccion_errada", "sin_dinero", "otro", null]) {
      expect(stopEarns(parada("no_entregado", motivo)), String(motivo)).toBe(false);
    }
    expect(stopEarns(parada("pendiente"))).toBe(false);
  });

  it("un no entregado que no es rechazo no se paga, con o sin tarifa", () => {
    expect(stopEarnings(parada("no_entregado", "no_estaba"), sinTarifa)).toEqual({ kind: "no_se_paga" });
    expect(stopEarnings(parada("no_entregado", "no_contesta"), { configured_rate: 8.5, base: 0 })).toEqual({ kind: "no_se_paga" });
  });

  it("la entrega y el rechazo se ganan con tarifa, o piden tarifa", () => {
    expect(stopEarnings(parada("entregado"), conTarifa)).toEqual({ kind: "ganada", base: 8.5 });
    expect(stopEarnings(parada("no_entregado", "rechazado"), conTarifa)).toEqual({ kind: "ganada", base: 8.5 });
    expect(stopEarnings(parada("entregado"), sinTarifa)).toEqual({ kind: "sin_tarifa" });
    expect(stopEarnings(parada("no_entregado", "rechazado"), { configured_rate: 8.5, base: null })).toEqual({ kind: "sin_tarifa" });
  });

  it("sin reportar todavía no se sabe: dice la tarifa que tendría", () => {
    expect(stopEarnings(parada("pendiente"), { configured_rate: 8.5, base: 0 })).toEqual({ kind: "pendiente", rate: 8.5 });
    expect(stopEarnings(parada("pendiente"), sinTarifa)).toEqual({ kind: "pendiente", rate: null });
  });

  it("la misma regla que el cálculo de la base (rider_pay_preview) y la que usa la tabla", () => {
    const sql = readFileSync(resolve(process.cwd(), "db/migrations/0197_rejection_photo_exemption.sql"), "utf8");
    expect(sql).toContain("case when s.status='entregado' or (s.status='no_entregado' and s.outcome_reason='rechazado') then t.amount else 0 end base");
    const tabla = readFileSync(resolve(process.cwd(), "components/routes.tsx"), "utf8");
    expect(tabla).toContain("const state = pr ? stopEarnings(s, pr) : null;");
    expect(tabla).toContain('<p className="text-xs font-medium text-slate-600">No se paga</p>');
    expect(tabla).toContain("solo entrega o rechazo");
  });
});
