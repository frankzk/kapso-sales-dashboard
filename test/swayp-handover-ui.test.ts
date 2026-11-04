// «Entregar a Swayp» · Lima, la pantalla (fase 3, owner 04-11-2026; MOM §9.1):
// el botón en «Hoy», el panel de la entrega (contador, por entregar, «No sale»
// con su motivo, entregadas, cierre y «Swayp no vino») y lo que el código del
// panel tiene que cumplir.

import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/pedidos/almacen",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/dashboard/pedidos/despacho/actions", () => ({
  openSwaypHandover: vi.fn(),
  scanSwaypHandover: vi.fn(),
  markSwaypNoSale: vi.fn(),
  undoSwaypNoSale: vi.fn(),
  closeSwaypHandover: vi.fn(),
  markSwaypNoVino: vi.fn(),
}));

import { WarehouseSwayp } from "@/components/warehouse-swayp";
import { SwaypHandoverPanel } from "@/components/warehouse-swayp-handover";
import {
  SWAYP_CLOSE_BUTTON,
  SWAYP_CLOSE_COUNT_LABEL,
  SWAYP_CLOSE_DRIVER_LABEL,
  SWAYP_HANDOVER_BUTTON,
  SWAYP_HANDOVER_HELP,
  SWAYP_HANDOVER_NO_PERMISSION,
  SWAYP_HANDOVER_TITLE,
  SWAYP_NO_SALE_BUTTON,
  SWAYP_NO_SALE_UNDO,
  SWAYP_NO_VINO_BUTTON,
} from "@/lib/swayp-handover";
import { buildWarehouseSwayp, type SwaypInput, type WarehouseSwaypData } from "@/lib/warehouse-swayp";
import { limaAt, swaypInput, swaypLimaGuide } from "./helpers/warehouse-swayp-fixtures";

const WED = "2026-11-04";
const NOW = limaAt(WED, "07:05");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const armed = swaypLimaGuide("KP1-S01", { day: WED, guide: "501", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", readyAt: "2026-11-03T20:00:00Z" });
const loaded = swaypLimaGuide("KP2-S02", {
  day: WED, guide: "502", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", extra: { custody_state: "courier", swayp_state: 5 },
});
const lost = swaypLimaGuide("KP3-S01", { day: WED, guide: "503", createdAt: "2026-11-03T15:00:00Z", emittedAt: "2026-11-03T15:00:00Z", readyAt: "2026-11-03T20:00:00Z" });

function lot(handover: SwaypInput["handover"], canHandover = true): WarehouseSwaypData {
  return buildWarehouseSwayp({ ...swaypInput([armed, loaded, lost]), handover, canHandover }, NOW);
}

const manifest = (extra: Record<string, unknown> = {}) => ({
  id: "m1", state: "office_check", received_by: null, custody_completed_at: null, cancelled_at: null, cancellation_reason: null, ...extra,
});
const item = (id: string, extra: Record<string, unknown> = {}) => ({
  shipment_id: `sh-${id}`, office_checked_at: null, office_checked_by: null, removed_at: null, removed_by: null, removal_reason: null, ...extra,
});

function section(data: WarehouseSwaypData): string {
  return renderToStaticMarkup(createElement(WarehouseSwayp, { data, onRefresh: async () => {}, busy: false, now: NOW }));
}
function panel(data: WarehouseSwaypData): string {
  return renderToStaticMarkup(createElement(SwaypHandoverPanel, { zone: data.hoy!, manifestId: "m1", onClose: () => {}, onChanged: async () => {} }));
}

describe("el botón en «Hoy»", () => {
  it("con permiso de Despacho y la entrega sin cerrar: «Entregar a Swayp · mié 4 nov»", () => {
    const t = text(section(lot(null)));
    expect(t).toContain(SWAYP_HANDOVER_BUTTON("mié 4 nov"));
    expect(t).toContain("Swayp recoge hacia las 07:00. Entrega sin abrir.");
  });

  it("sin permiso, quién la cierra; cerrada o «Swayp no vino», sin botón", () => {
    expect(text(section(lot(null, false)))).toContain(SWAYP_HANDOVER_NO_PERMISSION);
    const closed = lot({ manifest: manifest({ state: "in_custody", received_by: "Juan Pérez", custody_completed_at: "2026-11-04T12:10:00Z" }), items: [item("KP1-S01", { office_checked_at: "2026-11-04T12:04:00Z" })] });
    const t = text(section(closed));
    expect(t).not.toContain(SWAYP_HANDOVER_BUTTON("mié 4 nov"));
    expect(t).toContain("Entrega cerrada · recogió Juan Pérez (Swayp) · 1 caja · 07:10");
    const noVino = lot({ manifest: manifest({ state: "cancelled", cancellation_reason: "Swayp no vino" }), items: [item("KP1-S01", { removed_at: "x", removal_reason: "Ruta cancelada: Swayp no vino" })] });
    expect(text(section(noVino))).not.toContain(SWAYP_HANDOVER_BUTTON("mié 4 nov"));
  });
});

describe("el panel de la entrega", () => {
  const open = lot({
    manifest: manifest(),
    items: [
      item("KP1-S01", { office_checked_at: "2026-11-04T12:04:00Z", office_checked_by: "u-almacen-a" }),
      item("KP2-S02"),
      item("KP3-S01", { removed_at: "2026-11-04T12:06:00Z", removed_by: "u-almacen-a", removal_reason: "No sale: No se encontró la caja en la oficina. No estaba en el sitio." }),
    ],
  });

  it("título, ayuda, el contador grande y lo que falta", () => {
    const html = panel(open);
    const t = text(html);
    expect(t).toContain(SWAYP_HANDOVER_TITLE("miércoles 4 nov"));
    expect(t).toContain(SWAYP_HANDOVER_HELP);
    expect(t).toContain("1 de 2 entregadas");
    expect(t).toContain("falta 1 · 1 no sale");
    expect(html).toMatch(/role="status" aria-live="polite"/);
  });

  it("por entregar con «No sale», «No sale» con su motivo y «Deshacer», entregadas con hora y quién", () => {
    const t = text(panel(open));
    expect(t).toContain("Por entregar 1");
    expect(t).toContain("KP2-S02 · guía 502");
    expect(t).toContain(SWAYP_NO_SALE_BUTTON);
    expect(t).toContain("No sale 1");
    expect(t).toContain("No se encontró la caja en la oficina. No estaba en el sitio.");
    expect(t).toContain(SWAYP_NO_SALE_UNDO);
    expect(t).toContain("Entregadas 1");
    expect(t).toContain("KP1-S01 · Entregada a Swayp 07:04 · escaneó Almacén A");
    expect(t).toContain(SWAYP_NO_VINO_BUTTON);
    // Con una por entregar todavía no se puede cerrar.
    expect(t).not.toContain(SWAYP_CLOSE_BUTTON);
  });

  it("con «faltan 0», el cierre pide el nombre y el conteo del chofer", () => {
    const ready = lot({ manifest: manifest(), items: [item("KP1-S01", { office_checked_at: "2026-11-04T12:04:00Z" }), item("KP2-S02", { office_checked_at: "2026-11-04T12:05:00Z" })] });
    const t = text(panel(ready));
    expect(t).toContain("2 de 2 entregadas");
    expect(t).toContain("completa");
    expect(t).toContain(SWAYP_CLOSE_DRIVER_LABEL);
    expect(t).toContain(SWAYP_CLOSE_COUNT_LABEL);
    expect(t).toContain(SWAYP_CLOSE_BUTTON);
  });

  it("cerrada, el resumen y nada que escanear", () => {
    const closed = lot({ manifest: manifest({ state: "in_custody", received_by: "Juan Pérez", custody_completed_at: "2026-11-04T12:10:00Z" }), items: [item("KP1-S01", { office_checked_at: "2026-11-04T12:04:00Z" })] });
    const html = panel(closed);
    expect(text(html)).toContain("Entrega cerrada · recogió Juan Pérez (Swayp) · 1 caja · 07:10");
    expect(html).not.toContain("<form");
    expect(text(html)).not.toContain(SWAYP_NO_VINO_BUTTON);
  });
});

describe("el código del panel", () => {
  const src = readFileSync(resolve(process.cwd(), "components/warehouse-swayp-handover.tsx"), "utf8");
  it("escribe solo por las acciones de la entrega; el motivo no va en un window.prompt", () => {
    expect(src.startsWith('"use client";')).toBe(true);
    for (const action of ["scanSwaypHandover", "markSwaypNoSale", "undoSwaypNoSale", "closeSwaypHandover", "markSwaypNoVino"]) {
      expect(src, action).toContain(`${action}(`);
    }
    expect(src).not.toContain("window.prompt");
    expect(src).not.toContain("window.confirm");
    expect(src).not.toContain("fetch(");
    expect(src).not.toContain("localStorage");
  });
  it("los escaneos del lector van en cola: «Entregar» no se apaga mientras se guarda y el campo se limpia siempre", () => {
    expect(src).toContain("queue.current.push(value);");
    expect(src).toContain('disabled={!code.trim()} className="h-11 shrink-0 px-5"');
    const onScan = src.slice(src.indexOf("function onScan("), src.indexOf("async function run("));
    expect(onScan.indexOf('setCode("")')).toBeLessThan(onScan.indexOf("if (!value) return;"));
  });
  it("los errores del cierre y de «No sale» van junto a su campo; el foco no se pierde", () => {
    expect(src).toContain("{ inline: true }");
    expect(src).toContain("aria-invalid={countInvalid || undefined}");
    expect(src).toContain("aria-invalid={detailInvalid || undefined}");
    expect(src).toContain("selectRef.current?.focus();");
    expect(src).toContain("if (confirmNoVino) noVinoCancelRef.current?.focus();");
  });
  it("táctil y legible a 390 px: botones de 44 px, cifras tabulares, sin anchos fijos ni bordes laterales de color", () => {
    expect(src).toContain("pointer-coarse:h-11");
    expect(src).toContain("tabular-nums");
    // Un ancho fijo, no el ancho máximo de la hoja (`max-w-[640px]`).
    expect(src).not.toMatch(/(?<![-\w])w-\[\d+px\]/);
    expect(src).not.toMatch(/border-l-\d|border-r-\d/);
    expect(src).not.toContain("whitespace-nowrap");
  });
});
