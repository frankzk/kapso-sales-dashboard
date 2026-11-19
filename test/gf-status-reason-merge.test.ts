// El estado y su motivo de GF Courier, en una sola línea de la Actividad (owner, 19-11-2026).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mergeGfStatusReasons } from "@/lib/order-timeline-fact";

const e = (id: string, kind: string, occurredAt: string, note: string, guideCode = "AURELA-AUR901050", courier = "gf_courier") =>
  ({ id, kind, courier, guideCode, occurredAt, note, extraNote: null as string | null });

describe("mergeGfStatusReasons", () => {
  it("#AUR901050: «anulado» y «sin cobertura» del mismo aviso van juntos", () => {
    const out = mergeGfStatusReasons([
      e("s1", "courier_status", "2026-11-17T21:02:00.100Z", "GF Courier: pendiente · Lista para recojo."),
      e("r1", "courier_report", "2026-11-17T21:02:01.500Z", "GF Courier: Por asignar — por Yessenia Gonzales (GF)."),
      e("s2", "courier_status", "2026-11-19T14:57:10.000Z", "GF Courier: anulado · Anulada."),
      e("r2", "courier_report", "2026-11-19T14:57:12.000Z", "GF Courier: sin cobertura — por Frankz Kastner (GF)."),
    ]);
    expect(out.map((t) => t.id)).toEqual(["s1", "s2"]);
    expect(out[1]!.extraNote).toBe("GF Courier: sin cobertura — por Frankz Kastner (GF).");
    expect(out[0]!.extraNote).toBe("GF Courier: Por asignar — por Yessenia Gonzales (GF).");
  });
  it("un motivo sin cambio de estado cerca, de otra guía o de otro courier sigue solo", () => {
    const status = e("s", "courier_status", "2026-11-19T14:57:10.000Z", "GF Courier: anulado · Anulada.");
    const keep = (r: ReturnType<typeof e>) => mergeGfStatusReasons([status, r]).map((t) => t.id);
    expect(keep(e("r", "courier_report", "2026-11-19T15:10:00.000Z", "GF Courier: fecha de entrega cambiada al 20/11."))).toEqual(["s", "r"]);
    expect(keep(e("r", "courier_report", "2026-11-19T14:57:11.000Z", "GF Courier: sin cobertura.", "OTRA-GUIA"))).toEqual(["s", "r"]);
    expect(keep(e("r", "courier_report", "2026-11-19T14:57:11.000Z", "Swayp: entregado.", "AURELA-AUR901050", "swayp"))).toEqual(["s", "r"]);
  });
  it("un cambio de estado se queda con un solo motivo", () => {
    const out = mergeGfStatusReasons([
      e("s", "courier_status", "2026-11-19T14:57:10.000Z", "GF Courier: anulado · Anulada."),
      e("r1", "courier_report", "2026-11-19T14:57:11.000Z", "GF Courier: sin cobertura."),
      e("r2", "courier_report", "2026-11-19T14:57:50.000Z", "GF Courier: otra nota."),
    ]);
    expect(out.map((t) => t.id)).toEqual(["s", "r2"]);
  });
  it("la ficha lo pinta y la Actividad lo aplica", () => {
    expect(readFileSync("components/order-drawer.tsx", "utf8")).toContain("{t.extraNote && (");
    expect(readFileSync("lib/orders-master-access.ts", "utf8")).toContain("const timeline = mergeGfStatusReasons(");
  });
});
