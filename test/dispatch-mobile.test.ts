import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DispatchScanner } from "../components/dispatch-scanner";
import { DispatchWorkspace } from "../components/dispatch-workspace";
import type { DispatchManifest, DispatchManifestItem } from "../lib/dispatch-access";

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());
vi.mock("@/app/dashboard/pedidos/despacho/actions", () => ({
  addShipmentsToManifest: vi.fn(), cancelDispatchManifest: vi.fn(),
  createDispatchManifest: vi.fn(), handOverToCourier: vi.fn(),
  loadDispatchWorkspace: vi.fn(), removeManifestItem: vi.fn(), scanManifestItem: vi.fn(),
}));
vi.mock("@/components/dispatch-camera", () => ({ DispatchCamera: () => null }));

function manifest(office: boolean, received: boolean, state: DispatchManifest["state"]): DispatchManifest {
  return {
    id: "mobile-fixture", org_id: "org", courier: "propio", kind: "reparto",
    route_date: "2026-09-13", route_label: "", driver_name: "Roy", received_by: null,
    state, created_by: null, office_completed_at: null, custody_completed_at: null,
    cancellation_reason: null, created_at: "2026-09-12T12:00:00Z",
    items: [{
      id: "item", manifest_id: "mobile-fixture", shipment_id: "shipment", store_id: "store",
      added_by: null, added_at: "2026-09-12T12:00:00Z",
      office_checked_by: office ? "office-user" : null, office_checked_at: office ? "now" : null,
      pickup_checked_by: received ? "rider-user" : null, pickup_checked_at: received ? "now" : null,
      removed_by: null, removed_at: null, removal_reason: null, shipment: null,
    } satisfies DispatchManifestItem],
  };
}
function renderBox(box: DispatchManifest, canManage = true, canPickup = true) {
  return renderToStaticMarkup(createElement(DispatchWorkspace, {
    initialData: { manifests: [box], assignableShipments: [], warehousePending: 0 },
    initialSelectedId: box.id, stores: [], riders: [], canPrepare: false,
    canManage, canPickup, surface: "gf",
  }));
}

describe("mobile verification", () => {
  it("starts with camera and collapsed manual entry, without native autofocus", () => {
    const html = renderToStaticMarkup(createElement(DispatchScanner, { busy: false, disabled: false, onScan: vi.fn(), onCamera: vi.fn() }));
    expect(html).toContain("Escanear con cámara");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toMatch(/autofocus/i);
    expect(html).toContain("Código del paquete");
    expect(html).toContain('enterKeyHint="go"');
  });
  it("disables camera and manual submission while processing", () => {
    const html = renderToStaticMarkup(createElement(DispatchScanner, { busy: true, disabled: false, onScan: vi.fn(), onCamera: vi.fn() }));
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)?.length).toBe(4);
  });
  it("opens a planned box for verification with corrections disclosed separately", () => {
    const html = renderBox(manifest(false, false, "draft"));
    expect(html).toContain("Caja seleccionada");
    expect(html).not.toContain("Estás asignando a la ruta de");
    expect(html).toContain("Escanear con cámara");
    expect(html).toContain("Corregir contenido de la caja");
    expect(html).not.toContain("Carga recibida");
  });
  it("does not let pickup-only staff bypass office verification", () => {
    const html = renderBox(manifest(false, false, "draft"), false, true);
    expect(html).toContain("Primero completa la verificación de oficina");
    expect(html).not.toContain("Corregir contenido");
    expect(html).not.toContain("Continuar a recepción");
  });
  it("ready for pickup still requires a separate reception", () => {
    const html = renderBox(manifest(true, false, "ready_for_pickup"));
    expect(html).toContain("Cotejo del motorizado");
    expect(html).toContain("Escanear con cámara");
    expect(html).not.toContain("Carga recibida");
  });
  it("completed reception has no active scanner or destructive controls", () => {
    const html = renderBox(manifest(true, true, "in_custody"));
    expect(html).toContain("Carga recibida");
    expect(html).not.toContain("Escanear con cámara");
    expect(html).not.toContain("Corregir contenido");
  });
  it("office-only staff see completion without being sent to unauthorized receipt", () => {
    const html = renderBox(manifest(true, false, "ready_for_pickup"), true, false);
    expect(html).toContain("Caja verificada");
    expect(html).toContain("El motorizado continúa desde su acceso a Reparto");
    expect(html).not.toContain("Continuar a recepción");
    expect(html).not.toContain("Escanear con cámara");
  });
  it("cancelled boxes do not announce a new successful receipt", () => {
    const html = renderBox(manifest(true, true, "cancelled"));
    expect(html).not.toContain("Carga recibida");
    expect(html).not.toContain("Continuar a recepción");
  });
  it("touch focus is gated and requests release their lock on failure", () => {
    const scanner = readFileSync(new URL("../components/dispatch-scanner.tsx", import.meta.url), "utf8");
    const workspace = readFileSync(new URL("../components/dispatch-workspace.tsx", import.meta.url), "utf8");
    expect(scanner).toContain('(hover: hover) and (pointer: fine)');
    expect(workspace).toContain("scanLock.current");
    expect(workspace).toContain("finally { setBusy(false); scanLock.current = false; }");
  });
  it("mobile routes expose their exact load link and all four counters", () => {
    const source = readFileSync(new URL("../components/grupo-gf-courier.tsx", import.meta.url), "utf8");
    const mobile = source.split('aria-label="Cajas operativas"')[1]?.split("TABLE_WRAP_FROM")[0] ?? "";
    for (const key of ["route.assignedCount", "route.armedCount", "route.officeCheckedCount", "route.pickupCheckedCount", "encodeURIComponent(route.manifestId)"]) expect(mobile).toContain(key);
  });
});
