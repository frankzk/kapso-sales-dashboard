// La caja de Grupo GF ya reportada «No entregado» no frena otra guía (owner,
// 16-11-2026, #AUR900778; 0350, MOM §9.5).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aliclikOutputPolicy, type AliclikExistingOutput } from "@/lib/aliclik-output-policy";
import { gfNoEntregadaReportada, puertaDeSalidaAdicional, salidasQueEstorban } from "@/lib/shipment-output";

// #AUR900778: Chimbote, salió por error con Roy, «No entregado · Provincia».
const roy = (reported: boolean | undefined): AliclikExistingOutput => ({
  id: "00f1a578", courier: "propio", guide_code: "MOM-AUR900778-PROPIO-00F1A578", output_code: null,
  delivery_status: "pendiente", created_via: "grupo_gf_courier", custody_state: "courier",
  custody_transferred_at: "2026-11-14T16:31:30Z", no_entregado_reportado: reported,
});

describe("gfNoEntregadaReportada", () => {
  it("solo la caja propia, pendiente, con el motorizado y con el «No entregado» leído", () => {
    expect(gfNoEntregadaReportada(roy(true))).toBe(true);
    expect(gfNoEntregadaReportada(roy(false))).toBe(false);
    expect(gfNoEntregadaReportada(roy(undefined))).toBe(false);
    expect(gfNoEntregadaReportada({ ...roy(true), custody_state: "empresa" })).toBe(false);
    expect(gfNoEntregadaReportada({ ...roy(true), courier: "aliclik" })).toBe(false);
  });
});

describe("la guía de Aliclik", () => {
  it("en provincia, la caja de Roy ya reportada no estorba; sin el reporte, sí", () => {
    expect(aliclikOutputPolicy({ outputs: [roy(true)], operation: "provincia_cod", manual: true, person: true }).ok).toBe(true);
    const sin = aliclikOutputPolicy({ outputs: [roy(false)], operation: "provincia_cod", manual: true, person: true });
    expect(sin.ok).toBe(false);
    if (!sin.ok) expect(sin.error).toContain("MOM-AUR900778-PROPIO-00F1A578");
  });

  it("en Lima ya no pide motivo por una caja reportada «No entregado»", () => {
    expect(aliclikOutputPolicy({ outputs: [roy(true)], operation: "lima", manual: true, person: true }).ok).toBe(true);
  });

  it("las otras guías (Tanders, Swayp, la mesa manual) tampoco la cuentan", () => {
    expect(salidasQueEstorban([roy(true)])).toEqual([]);
    expect(puertaDeSalidaAdicional({ courier: "fenix", operation: "provincia_cod", outputs: [roy(true)], motivo: null }).ok).toBe(true);
  });
});

describe("la 0350", () => {
  const sql = readFileSync("db/migrations/0350_gf_replaced_by_aliclik_any_coverage.sql", "utf8");
  it("deja en devolución la caja en cualquier cobertura, con las mismas rejas y solo el servidor", () => {
    expect(sql).not.toContain("no_es_lima");
    expect(sql).toContain("v_stop.status <> 'no_entregado'");
    expect(sql).toContain("no_entregado_posterior_a_la_guia");
    expect(sql).not.toMatch(/security definer/i);
    expect(sql).toContain("grant execute on function public.gf_replace_output_with_aliclik(uuid, uuid) to service_role;");
  });
  it("la creación lee la última parada de cada caja con el motorizado", () => {
    const guide = readFileSync("lib/aliclik-guide.ts", "utf8");
    expect(guide).toContain('for (const o of withRider) o.no_entregado_reportado = last.get(o.id) === "no_entregado";');
  });
});
