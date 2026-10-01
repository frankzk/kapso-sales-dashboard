import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DRAFT_TTL_MS, draftDiffers, draftKey, parseDraft, serializeDraft, type StopDraftFields } from "@/lib/rider-draft";
import { validateStopReport } from "@/lib/routes";

// Revisión final del 30-09-2026: reportar obliga a salir de Chrome (WhatsApp,
// galería, llamada) y Android puede cerrarlo en el camino. El borrador devuelve
// lo marcado y la foto ya subida; «Guardar» lleva al campo que falta.

const fields: StopDraftFields = {
  status: "entregado",
  method: "yape",
  amount: "298",
  reason: "",
  note: "",
  photoPath: "r1/s2/entrega-abc.jpg",
  voucherPath: "r1/s2/yape-def.jpg",
  written: "",
  writtenPayment: "",
  reasonCode: "",
  reasonNote: "",
};
const NOW = Date.parse("2026-09-30T15:00:00Z");

describe("borrador de la parada", () => {
  it("se guarda y se recupera tal cual, con las fotos ya subidas", () => {
    const draft = parseDraft(serializeDraft(fields, NOW - 60_000), NOW, null);
    expect(draft).toMatchObject({ ...fields, v: 1 });
  });

  it("uno por parada", () => {
    expect(draftKey("s2")).toBe("kapta.reparto.borrador.s2");
    expect(draftKey("s2")).not.toBe(draftKey("s3"));
  });

  it("se ignora si la parada se reportó después: lo que dice la base manda", () => {
    const raw = serializeDraft(fields, NOW - 60_000);
    expect(parseDraft(raw, NOW, "2026-09-30T14:59:30Z")).toBeNull();
    expect(parseDraft(raw, NOW, "2026-09-30T14:00:00Z")).not.toBeNull();
  });

  it("vence a la jornada y no acepta fechas del futuro", () => {
    expect(parseDraft(serializeDraft(fields, NOW - DRAFT_TTL_MS - 1), NOW, null)).toBeNull();
    expect(parseDraft(serializeDraft(fields, NOW + 5 * 60_000), NOW, null)).toBeNull();
  });

  it("un borrador roto, de otra versión o con tipos raros no se usa", () => {
    expect(parseDraft("{", NOW, null)).toBeNull();
    expect(parseDraft(null, NOW, null)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...fields, v: 2, at: NOW }), NOW, null)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...fields, v: 1, at: NOW, status: "pendiente" }), NOW, null)).toBeNull();
    expect(parseDraft(JSON.stringify({ ...fields, v: 1, at: NOW, amount: 298 }), NOW, null)).toBeNull();
  });

  it("abrir la ficha sin tocar nada no deja borrador", () => {
    expect(draftDiffers(fields, { ...fields })).toBe(false);
    expect(draftDiffers({ ...fields, method: "efectivo" }, fields)).toBe(true);
  });
});

describe("la ficha usa el borrador y lleva al campo que falta", () => {
  const rider = readFileSync(resolve(process.cwd(), "components/rider-route.tsx"), "utf8");
  const form = rider.slice(rider.indexOf("export function ReportForm("), rider.indexOf("/**\n * Puntos que no vienen de una carga"));

  it("recupera al abrir, guarda al cambiar y borra al guardar el reporte", () => {
    expect(form).toContain("parseDraft(window.localStorage.getItem(draftKey(stop.id)), Date.now(), stop.reported_at)");
    expect(form).toContain("window.localStorage.setItem(draftKey(stop.id), serializeDraft(fields, Date.now()))");
    const success = form.slice(form.indexOf("if (!res.ok)"), form.indexOf("onDone();"));
    expect(success).toContain("window.localStorage.removeItem(draftKey(stop.id))");
    expect(form).toContain("Sigue lo que habías marcado");
    // Dice lo que volvió, sin afirmar que Chrome se cerró, y se va al primer cambio.
    expect(form).toContain("setRecovered(describeDraft(draft));");
    expect(form).not.toContain("Chrome se cerró");
    expect(form).toContain("if (restoredAt.current && restoredAt.current !== JSON.stringify(fields)) {");
  });

  it("«Guardar» solo se apaga sin saldo; si falta algo, lleva a ese campo", () => {
    expect(form).toContain("disabled={pending || balanceMissing}");
    expect(form).toContain("goTo(gap.field);");
    expect(form).toContain("onClick={() => goTo(gap.field)}");
    // Solo se desplaza la ficha: la barra de «Guardar» no se sale de la pantalla.
    expect(form).toContain('el.closest<HTMLElement>("[data-rider-scroll]")');
    expect(form).not.toContain('scrollIntoView({ block: "center"');
    expect(rider).toContain('<div data-rider-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain">');
    for (const key of ["estado", "metodo", "monto", "motivo", "nota", "delegado", "diferencia"]) {
      expect(form).toContain(`ref={anchor("${key}")}`);
    }
    expect(form).toContain('fieldRef={anchor("foto")}');
    expect(form).toContain('fieldRef={anchor("yape")}');
  });

  it("cada error de la validación dice qué campo lo arregla, en el mismo orden", () => {
    const base = { status: "entregado" as const, paymentMethod: null, collectedAmount: null, outcomeReason: null, note: null, hasPhoto: false, hasVoucher: false };
    const v = validateStopReport(base);
    expect(v.fields).toEqual(["metodo", "foto"]);
    expect(v.errors).toHaveLength(v.fields.length);
    expect(validateStopReport({ ...base, paymentMethod: "yape", collectedAmount: 10 }).fields).toEqual(["yape", "foto"]);
    expect(validateStopReport({ ...base, status: "no_entregado", outcomeReason: "rechazado" }).fields).toEqual(["foto"]);
    expect(validateStopReport({ ...base, status: "no_entregado", outcomeReason: "otro" }).fields).toEqual(["nota"]);
    expect(validateStopReport({ ...base, status: "no_entregado" }).fields).toEqual(["motivo"]);
  });
});
