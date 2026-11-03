// «Mover a esta caja» dentro del aviso de la cámara (26-10-2026). Con la cámara
// continua abierta, la lectura «Está en la caja de Yhoni…» solo se podía mover
// cerrando la cámara y buscando la fila. Ahora el aviso trae el botón y dice
// ahí mismo el error de «Mover» (MOM §29.13).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPORTED_STOP_MOVE_ERROR } from "@/lib/gf-scan-return";

const read = (path: string) => readFileSync(path, "utf8");

describe("el aviso de la cámara", () => {
  const camera = read("components/dispatch-camera.tsx");

  it("pinta el arreglo dentro del aviso (role=status), en ámbar, con su estado ocupado", () => {
    const banner = camera.slice(camera.indexOf('role="status" aria-live="polite" aria-atomic="true"'), camera.indexOf("{pending > 0 && <p"));
    expect(banner).toContain("statusAction.onClick");
    expect(banner).toContain("disabled={statusAction.busy}");
    expect(banner).toContain("status.warn ? \"border-amber-200 bg-amber-50 text-amber-900\"");
  });
});

describe("ScanAction", () => {
  const scan = read("components/scan-action.tsx");

  it("ofrece el arreglo de la última línea y dice su resultado en el mismo aviso", () => {
    expect(scan).toContain("lineAction(r.line)");
    expect(scan).toContain("statusAction={");
    // El error de «Mover» se pinta en rojo en el aviso; el éxito, en verde.
    expect(scan).toContain("r.error ? { ok: false, text: r.error } : { ok: true, text: `✓ ${r.notice");
    // Una lectura posterior no se pisa con el resultado de la anterior.
    expect(scan).toContain("current.token === read.token");
  });
});

describe("las dos pantallas que escanean para una caja", () => {
  it("«Agregar pedidos» de la caja: «Mover a esta caja» con el paquete en la mano", () => {
    const box = read("components/gf-box-add-packages.tsx");
    expect(box).toContain('label: "Mover a esta caja"');
    expect(box).toContain("run: () => moveLine(l)");
    expect(box.match(/inHand: true/g)?.length).toBe(2);
    // La fila usa el mismo «Mover».
    expect(box).toContain("await moveLine(l);");
  });

  it("«Por QR» de Despacho del día: el mismo botón sobre su «Mover»", () => {
    const board = read("components/dispatch-day-board.tsx");
    expect(board).toContain('label: "Mover a esta caja", busyLabel: "Moviendo…", run: () => moveScanned(l)');
    expect(board).toContain("if (\"error\" in result && result.error) return { error: result.error };");
  });
});

describe("«Mover» sobre una parada que ya se reportó", () => {
  it("dice que se vuelva a escanear, en vez del mensaje de la base", () => {
    const src = read("app/dashboard/courier/actions.ts");
    const move = src.slice(src.indexOf("export async function moveManifestItem"), src.indexOf("async function recalculateManifestState"));
    expect(move).toContain("/ya fue reportada/.test(removeError.message)");
    expect(move).toContain("return { error: REPORTED_STOP_MOVE_ERROR }");
    expect(REPORTED_STOP_MOVE_ERROR).toContain("Vuelve a escanearlo");
  });
});
