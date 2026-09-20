import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanProgressDone, scanProgressText } from "@/lib/scan-progress";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("escaneo continuo con avance (MOM §30.9)", () => {
  it("dice cuántos van y cuántos faltan", () => {
    expect(scanProgressText({ done: 1, total: 3 })).toBe("Confirmados 1 de 3 · faltan 2");
    expect(scanProgressText({ done: 3, total: 3 })).toBe("Confirmados 3 de 3 · listo");
    expect(scanProgressText({ done: 4, label: "4 en la caja de Roy" })).toBe("4 en la caja de Roy");
    expect(scanProgressDone({ done: 3, total: 3 })).toBe(true);
    expect(scanProgressDone({ done: 2, total: 3 })).toBe(false);
    expect(scanProgressDone({ done: 0, total: 0 })).toBe(false);
  });

  it("la cámara sigue abierta en modo continuo, ignora el mismo QR seguido y se cierra sola al terminar", () => {
    const cam = read("components/dispatch-camera.tsx");
    expect(cam).toContain("continuous?: boolean");
    expect(cam).toContain("REPEAT_MS");
    expect(cam).toContain("AUTO_CLOSE_MS");
    // En continuo la lectura NO detiene la cámara ni la cierra.
    const cont = cam.slice(cam.indexOf("if (continuous) {"), cam.indexOf("handledRef.current = true;"));
    expect(cont).not.toContain("onClose()");
    expect(cont).not.toContain("stop()");
    expect(cam).toContain("Todo confirmado");
    expect(cam).toContain(">Listo<");
  });

  it("«Confirmar todos» del motorizado y el escaneo de asignación usan el modo continuo", () => {
    const rider = read("components/rider-route.tsx");
    const block = rider.slice(rider.indexOf("Confirmar todos · escanea"), rider.indexOf("headerMessage &&"));
    expect(block).toContain("continuous");
    expect(block).toContain("progress={confirmProgress}");
    expect(rider).toContain("scanSession.base + scanSession.scanned");
    const board = read("components/dispatch-day-board.tsx");
    expect(board).toContain("en la caja de ${riderName}` } : undefined}");
    const action = read("components/scan-action.tsx");
    expect(action).toContain("status={lastRead}");
  });
});
