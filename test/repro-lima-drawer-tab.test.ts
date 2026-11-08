// «Repro Lima» como pestaña de la ficha del pedido (07-11-2026, MOM §9.5).
//
// Pedido del owner: «Atender» abría una hoja aparte encima de la ficha y se
// veían los dos paneles. Ahora es la pestaña «Repro Lima» de la ficha, después
// de «Chatby», y solo sale mientras el pedido está en Repro Lima. Aquí se
// prueba quién la ve, dónde va, que el tablero la abre y que el candado se
// suelta al salir de ella.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isReproLimaCandidate, reproAttendMode } from "@/lib/repro-lima-pending";
import { orderDrawerHref, readOrderDrawerRequest, workspaceForDrawerSection } from "@/lib/order-drawer-href";
import {
  clearReproLimaHandoff,
  clearReproLimaQueue,
  handOffReproLima,
  reproLimaHandoff,
  reproLimaNext,
  reproLimaQueueVersion,
  setReproLimaQueue,
  subscribeReproLimaQueue,
} from "@/lib/repro-lima-queue";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
const drawer = read("components/order-drawer.tsx");
const panel = read("components/repro-lima-panel.tsx");
const board = read("components/repro-lima-board.tsx");
const access = read("lib/repro-lima-access.ts");
const layout = read("app/dashboard/layout.tsx");
const host = read("components/order-drawer-host.tsx");
const master = read("components/orders-master.tsx");
const masterPage = read("app/dashboard/pedidos/page.tsx");

function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = src.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return src.slice(from, to + end.length);
}

describe("la pestaña sale solo para pedidos que están en Repro Lima", () => {
  it("quién puede estar: Lima y por entregar, la misma regla que la lectura de la etapa", () => {
    expect(isReproLimaCandidate({ coverage: "lima", macro_stage: "en_curso" })).toBe(true);
    expect(isReproLimaCandidate({ coverage: "lima", macro_stage: "por_confirmar" })).toBe(true);
    expect(isReproLimaCandidate({ coverage: "lima", macro_stage: "preparacion" })).toBe(true);
    expect(isReproLimaCandidate({ coverage: "lima", macro_stage: "por_despachar" })).toBe(true);
    expect(isReproLimaCandidate({ coverage: "lima", macro_stage: "por_cerrar" })).toBe(false);
    expect(isReproLimaCandidate({ coverage: "lima", macro_stage: "finalizado" })).toBe(false);
    expect(isReproLimaCandidate({ coverage: "provincia_cod", macro_stage: "en_curso" })).toBe(false);
    expect(isReproLimaCandidate({ coverage: null, macro_stage: "en_curso" })).toBe(false);
    // `loadReproLima` (con `attention`) filtra la etapa con la misma función.
    expect(access).toContain("(!opts.attention || isReproLimaCandidate(row)) &&");
  });

  it("quien decide es `loadReproRow`: con fila sale la pestaña; sin fila o con error, no", () => {
    const tabs = between(drawer, "const tabs: { id: DrawerWorkspaceView;", "\n  ];");
    expect(tabs).toContain('...(reproRow || (reproLoading && workspace === "reprolima") ? [{ id: "reprolima" as const, label: "Repro Lima" }] : []),');
    const lookup = between(drawer, "loadReproRow(orderId)", "});\n    return () => {");
    expect(lookup).toContain('if ("error" in result) setReproLookup({ orderId, status: "none", message: result.error });');
    expect(lookup).toContain('else if (result.row) setReproLookup({ orderId, status: "ready", row: result.row });');
    expect(lookup).toContain('else setReproLookup({ orderId, status: "none", message: null });');
    expect(drawer).toContain('const reproRow = reproLookup?.orderId === orderId && reproLookup.status === "ready" ? reproLookup.row : null;');
    // El panel solo se monta con la fila.
    expect(drawer).toContain("{reproRow && reproMountedFor === orderId && reproSession.orderId === orderId && (");
  });

  it("una sola lectura por ficha, solo para quien atiende y solo si el pedido puede estar; sin sondeo", () => {
    const gate = between(drawer, "const reproCandidate =", ";\n");
    expect(gate).toContain("canAttendReproLima &&");
    expect(gate).toContain("reproRequested ||");
    expect(gate).toContain("isReproLimaCandidate(detail.row)");
    const effect = between(drawer, "  useEffect(() => {\n    if (!reproCandidate) {", "}, [orderId, reproCandidate]);");
    expect(effect).not.toContain("setInterval");
    expect(effect).not.toContain("setTimeout");
    expect(drawer.match(/loadReproRow\(/g)).toHaveLength(1);
  });

  it("solo con `repro_lima.manage`, en el panel y en el Master", () => {
    expect(layout).toContain('canAttendReproLima={permissions.can("repro_lima.manage")}');
    expect(host).toContain("canAttendReproLima={permissions.canAttendReproLima}");
    expect(masterPage).toContain('canAttendReproLima={perms.can("repro_lima.manage")}');
    expect(master).toContain("canAttendReproLima={canAttendReproLima}");
    expect(drawer).toContain("canAttendReproLima = false,");
  });

  it("pedida y ausente (salió de la etapa): Operar, con el porqué", () => {
    const fallback = between(drawer, "const reproSettledOut =", "}, [workspace, reproRow, reproSettledOut");
    expect(fallback).toContain('setWorkspace("operar");');
    expect(fallback).toContain("Este pedido ya no está pendiente de entrega en Lima: no tiene la pestaña «Repro Lima». Actualiza la lista.");
  });
});

describe("dónde va la pestaña", () => {
  it("la última, después de «Chatby» y «Kapso»", () => {
    const tabs = between(drawer, "const tabs: { id: DrawerWorkspaceView;", "\n  ];");
    const ids = [...tabs.matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["operar", "informacion", "actividad", "punto", "chatby", "kapso", "reprolima"]);
    expect(tabs).toContain('label: "Repro Lima"');
    // Su panel, después de los de Chatby y Kapso.
    expect(drawer.indexOf('id="pedido-panel-reprolima"')).toBeGreaterThan(drawer.indexOf('id="pedido-panel-chatby"'));
    expect(drawer.indexOf('id="pedido-panel-reprolima"')).toBeGreaterThan(drawer.indexOf('id="pedido-panel-kapso"'));
    expect(drawer).toContain('export type DrawerWorkspaceView = "operar" | "informacion" | "actividad" | "punto" | "chatby" | "kapso" | "reprolima";');
  });

  it("`?seccion=reprolima` la pide, en el panel (`ficha`) y en el Master (`abrir`)", () => {
    expect(workspaceForDrawerSection("reprolima")).toBe("reprolima");
    expect(orderDrawerHref("abc", "reprolima", { pathname: "/dashboard/pedidos/repro-lima", search: "atencion=hoy" }))
      .toBe("/dashboard/pedidos/repro-lima?atencion=hoy&ficha=abc&seccion=reprolima");
    expect(readOrderDrawerRequest({ pathname: "/dashboard/pedidos/repro-lima", search: "ficha=abc&seccion=reprolima" }))
      .toEqual({ orderId: "abc", section: "reprolima" });
    expect(orderDrawerHref("abc", "reprolima", { pathname: "/dashboard/pedidos" })).toBe("/dashboard/pedidos?abrir=abc&seccion=reprolima");
  });
});

describe("el tablero abre la ficha en la pestaña", () => {
  it("«Atender» abre la ficha del pedido en «Repro Lima», sin hoja aparte", () => {
    expect(between(board, "function rowActions(", "\n  }")).toContain('onClick={() => openDrawer(row.orderId, "reprolima")}>Atender</OpsButton>');
    expect(board).not.toContain("ReproLimaSheet");
    expect(board).not.toContain("loadReproRow");
    expect(existsSync(resolve(process.cwd(), "components/repro-lima-sheet.tsx"))).toBe(false);
    expect(panel).not.toContain("<SidePanel");
  });

  it("el modo lo decide la fila: acuerdo programado y «Cerrados», para leer", () => {
    expect(reproAttendMode({ list: "cerrados", agreement: null })).toBe("read");
    expect(reproAttendMode({ list: "programados", agreement: { agreedOn: "2026-11-08" } })).toBe("read");
    expect(reproAttendMode({ list: "programados", agreement: null })).toBe("edit");
    expect(reproAttendMode({ list: "por_decidir", agreement: null })).toBe("edit");
    expect(reproAttendMode({ list: "llamar_despues", agreement: null })).toBe("edit");
  });

  it("publica el siguiente de SU lista para «Guardar y pasar al siguiente»", () => {
    const publish = between(board, "useEffect(() => {\n    if (retriesOnly) return;", "}, [inQueue, caseById, retriesOnly]);");
    expect(publish).toContain("next: (orderId) => nextAfter(orderId)?.orderId ?? null");
    expect(publish).toContain("return () => clearReproLimaQueue(queue);");
    expect(drawer).toContain("const reproHasNext = useMemo(");
    expect(drawer).toContain("hasNext={reproHasNext}");
  });
});

describe("el puente tablero → ficha (lib/repro-lima-queue.ts)", () => {
  it("sin tablero no hay siguiente; con tablero, el suyo; al irse, solo borra el suyo", () => {
    expect(reproLimaNext("a")).toBeNull();
    const listener = vi.fn();
    const unsubscribe = subscribeReproLimaQueue(listener);
    const before = reproLimaQueueVersion();
    const first = { next: (id: string) => (id === "a" ? "b" : null) };
    setReproLimaQueue(first);
    expect(reproLimaQueueVersion()).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reproLimaNext("a")).toBe("b");
    const second = { next: () => "c" };
    setReproLimaQueue(second);
    clearReproLimaQueue(first);
    expect(reproLimaNext("a")).toBe("c");
    clearReproLimaQueue(second);
    expect(reproLimaNext("a")).toBeNull();
    unsubscribe();
  });

  it("el aviso del anterior llega a la ficha del siguiente y se borra una vez mostrado", () => {
    handOffReproLima("b", { orderName: "#KP1", text: "Avisa a Almacén." });
    expect(reproLimaHandoff("x")).toBeNull();
    expect(reproLimaHandoff("b")).toEqual({ orderName: "#KP1", text: "Avisa a Almacén." });
    expect(reproLimaHandoff("b")).not.toBeNull();
    clearReproLimaHandoff("b");
    expect(reproLimaHandoff("b")).toBeNull();
  });
});

describe("el candado sigue a la pestaña (D10)", () => {
  const effect = between(panel, "  useEffect(() => {\n    // Fuera de la pestaña no se toma nada", "}, [orderId, mode, claimAttempt, reload, visible]);");

  it("se toma solo con la pestaña a la vista y en modo atender", () => {
    expect(effect.indexOf('if (mode !== "edit" || !visible) return;')).toBeLessThan(effect.indexOf("claimReproCase(orderId"));
    expect(drawer).toContain('active={workspace === "reprolima"}');
  });

  it("salir de la pestaña lo suelta (la limpieza del efecto) y volver lo toma otra vez", () => {
    const cleanup = between(effect, "    return () => {\n      active = false;", "\n    };\n  }, [orderId");
    expect(cleanup).toContain("void releaseReproCase(session.caseId).catch(() => undefined);");
    expect(cleanup).toContain("clearInterval(heartbeat)");
    expect(cleanup).toContain('window.removeEventListener("pagehide", onPageHide);');
    // `visible` en las dependencias: al cambiar de pestaña el efecto se limpia.
    expect(effect.endsWith("}, [orderId, mode, claimAttempt, reload, visible]);")).toBe(true);
  });

  it("el panel se queda montado (oculto) al cambiar de pestaña: lo escrito no se pierde", () => {
    const mount = between(drawer, "{reproRow && reproMountedFor === orderId", "</section>");
    expect(mount).toContain('hidden={workspace !== "reprolima"}');
    expect(drawer).toContain("setReproMountedFor(orderId);");
  });

  it("cerrar la ficha también lo suelta: «Soltar», «Cerrar» y desmontar", () => {
    expect(between(panel, "function doExit() {", "\n  }")).toContain("releaseCurrentClaim();");
    expect(drawer).toContain("onClose={onClose}");
    expect(drawer).toContain("key={`${orderId}:${reproSession.key}`}");
  });
});

describe("el MOM y el diseño", () => {
  const mom = read("docs/mom/master-pedidos-v1.md").replace(/\s+/g, " ");
  it("§9.5 dice que «Atender» vive en la pestaña «Repro Lima» de la ficha", () => {
    expect(mom).toContain("«Atender» abre la ficha del pedido en su pestaña «Repro Lima»");
    expect(mom).toContain("solo mientras el pedido está en Repro Lima");
  });
  it("DESIGN.md lista la pestaña", () => {
    expect(read("DESIGN.md")).toContain("**Pestaña «Repro Lima» de la ficha del pedido**");
  });
});
