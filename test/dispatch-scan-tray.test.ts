// Modo escaneo (MOM §29.13): bandeja temporal y contadores de la lista viva.
import { describe, expect, it } from "vitest";
import { addToTray, removeFromTray, summarizeScans } from "@/lib/dispatch-scan-tray";

describe("bandeja «escanear primero»", () => {
  it("acumula códigos normalizados sin repetir y respeta el orden de escaneo", () => {
    let tray = addToTray([], "  KP1-S01 ", "t1");
    tray = addToTray(tray, "kp1-s01", "t2");
    tray = addToTray(tray, "https://kapta.app/q/abc-123", "t3");
    tray = addToTray(tray, "", "t4");
    expect(tray.map((e) => e.code)).toEqual(["KP1-S01", "abc-123"]);
    expect(removeFromTray(tray, "KP1-S01").map((e) => e.code)).toEqual(["abc-123"]);
  });
});

describe("summarizeScans", () => {
  it("cuenta por resultado y suma el efectivo solo de lo que entró en la caja", () => {
    expect(
      summarizeScans([
        { status: "asignado", amount: 89 },
        { status: "asignado", amount: 149.5 },
        { status: "ya_en_caja", amount: 99 },
        { status: "en_otra_caja", amount: 50 },
        { status: "no_elegible", amount: 20 },
        { status: "bloqueado_efectivo", amount: 300 },
        { status: "desconocido", amount: null },
      ]),
    ).toEqual({ total: 7, assigned: 2, alreadyInBox: 1, inOtherBox: 1, blocked: 2, unknown: 1, cash: 238.5 });
  });
});

describe("asignar no coteja (22-09-2026)", () => {
  it("el escaneo de asignación toma y asigna, pero la verificación de oficina queda aparte", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/app/dashboard/courier/actions.ts`, "utf8");
    const body = src.slice(src.indexOf("export async function scanAssignToRider("), src.indexOf("/** Lo que el panel lateral de Rutas"));
    expect(body).not.toContain('"office"');
    expect(body).not.toContain("scanManifestItem(");
    expect(body).toContain("Falta verificarlo en oficina");
  });
});
