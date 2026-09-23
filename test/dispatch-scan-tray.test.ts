// Modo escaneo (MOM §29.13): bandeja temporal y contadores de la lista viva.
import { describe, expect, it } from "vitest";
import { addToTray, optimisticBox, removeFromTray, summarizeScans } from "@/lib/dispatch-scan-tray";

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

describe("asignar por QR sin esperar (22-09-2026)", () => {
  it("el número de la caja sube en el mismo instante del QR y no cuenta dos veces", () => {
    const box = { count: 4, cash: 400, orderIds: new Set(["o1", "o2", "o3", "o4"]) };
    expect(optimisticBox([], box)).toEqual({ count: 4, cash: 400, pending: 0 });
    // Uno en camino y uno ya asignado que la caja cargada todavía no trae.
    expect(optimisticBox([{ status: "procesando", amount: null }, { status: "asignado", amount: 89, orderId: "o5" }], box)).toEqual({ count: 6, cash: 489, pending: 1 });
    // Al refrescar la caja, o5 ya está dentro: deja de sumarse aparte.
    expect(optimisticBox([{ status: "asignado", amount: 89, orderId: "o5" }], { ...box, count: 5, cash: 489, orderIds: new Set([...box.orderIds, "o5"]) })).toEqual({ count: 5, cash: 489, pending: 0 });
    // Los que fallaron o ya estaban no suman; el mismo pedido dos veces, una.
    expect(optimisticBox([{ status: "no_elegible", amount: 50 }, { status: "ya_en_caja", amount: 70, orderId: "o1" }, { status: "asignado", amount: 10, orderId: "o6" }, { status: "asignado", amount: 10, orderId: "o6" }], box)).toEqual({ count: 5, cash: 410, pending: 0 });
  });

  it("el escaneo no reconstruye la página: un control de permisos, recálculo diferido, refresco único", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(`${process.cwd()}/${f}`, "utf8");
    const src = read("app/dashboard/courier/actions.ts");
    const body = src.slice(src.indexOf("export async function scanAssignToRider("), src.indexOf("/** Lo que el panel lateral de Rutas"));
    expect(body).toContain("const fx = deferredEffects();");
    expect(body).toContain("takeOrdersCore(auth,");
    expect(body).toContain("assignRouteCore(auth,");
    expect(body).not.toContain("takeGroupGfCourierOrders(");
    expect(src).toContain("after(async () => { await recomputeOrderMasterSafe(");
    const scan = read("components/scan-action.tsx");
    expect(scan).toContain("assignQueue.current.push(clean);");
    expect(scan).toContain("onPending?.(clean);");
    const board = read("components/dispatch-day-board.tsx");
    expect(board).toContain("onPending={pendingLine}");
    expect(board).toContain("scheduleRefresh()");
    expect(board).not.toMatch(/line\.status === "ya_en_caja"\) router\.refresh\(\)/);
  });
});

describe("devoluciones en Rutas (22-09-2026)", () => {
  it("la columna Devolver, el botón solo con pendientes y el Devuelto en la liquidación", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(`${process.cwd()}/${f}`, "utf8");
    const ledger = read("components/courier-routes-ledger.tsx");
    expect(ledger).toContain("orgId && pendingReturns.length > 0 && (");
    expect(ledger).toContain("<ReturnsBadge row={row} />");
    expect(ledger).toContain('verb: "Devueltos"');
    expect(read("lib/courier-route-ledger.ts")).toContain('.eq("kind", "returned_to_office")');
    expect(read("components/routes.tsx")).toContain("s.returned_at");
    expect(read("db/migrations/0189_gf_return_rejected.sql")).toContain("if v_stop.outcome_reason = 'rechazado' then");
  });
});
