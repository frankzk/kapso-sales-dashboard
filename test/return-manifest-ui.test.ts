// La pantalla del manifiesto de devolución (0307, owner 04-11-2026): la
// pestaña «Manifiestos» de Devoluciones, el detalle con su escáner, contador y
// tres paneles, el botón de Despacho del día y la línea del drawer. Se fija el
// cableado: quién lo ve (permiso de Almacén), qué llama y qué NO enseña.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RETURN_MANIFESTS_PATH,
  RETURN_MANIFESTS_TAB_PATH,
  returnManifestActaUrl,
  returnManifestPath,
  returnManifestPhotoUrl,
} from "@/lib/return-manifest";

const read = (path: string) => readFileSync(path, "utf8");

describe("las rutas del manifiesto", () => {
  it("la pestaña, el detalle, el acta y la foto", () => {
    expect(RETURN_MANIFESTS_PATH).toBe("/dashboard/pedidos/devoluciones");
    expect(RETURN_MANIFESTS_TAB_PATH).toBe("/dashboard/pedidos/devoluciones?vista=manifiestos");
    expect(returnManifestPath("abc")).toBe("/dashboard/pedidos/devoluciones/manifiestos/abc");
    expect(returnManifestActaUrl("abc", "pdf")).toBe("/api/pedidos/devoluciones/manifiestos/abc/acta?formato=pdf");
    expect(returnManifestActaUrl("abc", "xlsx")).toBe("/api/pedidos/devoluciones/manifiestos/abc/acta?formato=xlsx");
    expect(returnManifestPhotoUrl("abc")).toBe("/api/pedidos/devoluciones/manifiestos/abc/foto");
    expect(returnManifestPhotoUrl("abc", "return-manifests/o/abc/x y.jpg")).toBe("/api/pedidos/devoluciones/manifiestos/abc/foto?path=return-manifests%2Fo%2Fabc%2Fx%20y.jpg");
  });

  it("el cargador sigue exportando las mismas rutas (las acciones las usan para revalidar)", () => {
    // Es server-only: se lee su fuente. Las rutas viven en el módulo puro.
    expect(read("lib/return-manifest-access.ts")).toContain('export { RETURN_MANIFESTS_PATH, returnManifestPath } from "@/lib/return-manifest";');
  });
});

describe("Devoluciones: dos pestañas", () => {
  const page = read("app/dashboard/pedidos/devoluciones/page.tsx");
  it("«Recepción» (Tanders, Shalom, caja suelta de Grupo GF) y «Manifiestos», con el permiso de Almacén", () => {
    expect(page).toContain("if (!permissions.can(RETURN_MANIFEST_PERMISSION)) {");
    expect(page).toContain('if (sp.vista === "manifiestos") {');
    expect(page).toContain('<ReturnsReception initialData={data} nav={<ReturnsTabs active="recepcion" />} />');
    expect(page).toContain('tabs={<ReturnsTabs active="manifiestos" />}');
    expect(page).toContain("listReturnManifestRiders(org.org_id)");
    const list = read("components/return-manifests.tsx");
    expect(list).toContain('{tab("recepcion", RETURN_MANIFESTS_PATH, "Recepción")}');
    expect(list).toContain('{tab("manifiestos", RETURN_MANIFESTS_TAB_PATH, "Manifiestos")}');
  });

  it("la lista avisa del manifiesto abierto hace más de un día y «Nuevo manifiesto» es de Grupo GF", () => {
    const list = read("components/return-manifests.tsx");
    expect(list).toContain("const stale = manifests.filter((m) => m.stale);");
    expect(list).toContain('title="Nuevo manifiesto de devolución"');
    expect(list).toContain('<option value="propio">Grupo GF</option>');
    expect(list).toContain("await openReturnManifest({ riderId, arrivedOn: arrivedOn || null })");
    expect(list).toContain("router.push(returnManifestPath(res.manifestId));");
  });
});

describe("el detalle", () => {
  const page = read("app/dashboard/pedidos/devoluciones/manifiestos/[id]/page.tsx");
  const view = read("components/return-manifest-detail.tsx");

  it("lo carga el cargador que comprueba el permiso y la organización", () => {
    expect(page).toContain("await getReturnManifestDetail(id)");
    expect(page).toContain("permissions.can(RETURN_MANIFEST_PERMISSION)");
  });

  it("escáner en modo manifiesto, contador, tres paneles, cerrar, anular y el acta", () => {
    expect(view).toContain("<ReturnManifestScanner manifestId={header.id} progress={{ done: totals.expectedReceived, total: totals.expectedTotal }} />");
    expect(view).toContain("{detail.counter}");
    for (const title of ['title="Llegó"', 'title="Esperado y no llegó"', 'title="Llegó sin esperarse"', 'title="Falta"', 'title="Con el motorizado"', 'title="Reprogramado, sigue con él"']) {
      expect(view).toContain(title);
    }
    expect(view).toContain("await closeReturnManifest(header.id, closeWho)");
    expect(view).toContain("await cancelReturnManifest(header.id, cancelReason)");
    expect(view).toContain('returnManifestActaUrl(header.id, "pdf")');
    expect(view).toContain('returnManifestActaUrl(header.id, "xlsx")');
    // Anular, solo sin cajas recibidas; cerrar, con «Entregó» y sin no identificadas sin nota.
    expect(view).toContain("disabled={totals.received > 0}");
    expect(view).toContain("disabled={acting || closeWho.trim().length < 3 || unnoted > 0}");
    // Declaró frente a llegaron, y el aviso del abierto viejo.
    expect(view).toContain("`Declaró ${totals.declared} · llegaron ${totals.arrived}`");
    expect(view).toContain("{header.stale && (");
  });

  it("la foto es opcional y se sube por la ruta autenticada", () => {
    expect(view).toContain('await fetch(returnManifestPhotoUrl(header.id), { method: "POST", body })');
    expect(view).toContain("La foto de la hoja o del acta firmada es opcional.");
  });

  it("ni el detalle ni la lista enseñan datos del cliente", () => {
    for (const file of [view, read("components/return-manifests.tsx")]) {
      expect(file).not.toMatch(/customerName|customerPhone|customer_name|customer_phone|delivery_address/);
    }
  });
});

describe("el escáner de Devoluciones, en modo manifiesto", () => {
  const scanner = read("components/returns-scanner.tsx");
  it("cada lectura va al manifiesto; la no identificada pide nota", () => {
    expect(scanner).toContain("export function ReturnManifestScanner(");
    expect(scanner).toContain("const res = await scanReturnManifest(manifestId, code);");
    expect(scanner).toContain("await setReturnManifestLineNote(lineId, text)");
  });
  it("la cámara no se cierra sola al completar lo esperado: llegan también cajas sin esperarse", () => {
    const manifestPart = scanner.slice(scanner.indexOf("export function ReturnManifestScanner("));
    expect(manifestPart).toContain("progress={{ done: progress.done, label: `Recibidos ${progress.done} de ${progress.total} esperados` }}");
    // El escáner de siempre no cambia.
    expect(scanner).toContain('verb: "Devueltos"');
  });
});

describe("Despacho del día: «Nuevo manifiesto de devolución» por motorizado", () => {
  it("solo con el permiso de Almacén, en la tarjeta «Devoluciones»", () => {
    const page = read("app/dashboard/courier/page.tsx");
    expect(page).toContain("const canReturnManifest = permissions.can(RETURN_MANIFEST_PERMISSION);");
    expect(page).toContain("canReturnManifest ? listReturnManifestRiders(orgId).catch(() => []) : Promise.resolve([])");
    const board = read("components/dispatch-day-board.tsx");
    expect(board).toContain("{(props.returnManifestRiders?.length ?? 0) > 0 && <ReturnManifestRiderButtons riders={props.returnManifestRiders!} />}");
    expect(read("components/grupo-gf-courier.tsx")).toContain("returnManifestRiders={returnManifestRiders}");
    const buttons = read("components/return-manifests.tsx");
    expect(buttons).toContain("const withReturns = riders.filter((r) => r.expected > 0 || r.openManifestId);");
  });
});

describe("el drawer del pedido: el historial de manifiestos de la salida", () => {
  it("se lee con el cargador del backend y se pinta bajo la salida", () => {
    // Lo carga la acción del servidor: lib/orders-master-access.ts entra al
    // bundle del cliente (orders-master.tsx) y el cargador es server-only.
    const action = read("app/dashboard/pedidos/actions.ts");
    expect(action).toContain("returnManifestEntriesForShipments(detail.guides.map((g) => g.id))");
    const loader = read("lib/orders-master-access.ts");
    for (const m of loader.matchAll(/^import (.*) from "@\/lib\/return-manifest-access";$/gm)) expect(m[1]).toMatch(/^type /);
    expect(loader).not.toContain('import("@/lib/return-manifest-access")');
    const drawer = read("components/order-drawer.tsx");
    expect(drawer).toContain("<ReturnManifestHistory entries={detail.returnManifestEntries?.[g.id] ?? []} />");
    expect(drawer).toContain("<Badge tone={RETURN_MANIFEST_LINE_TONE[e.outcome]} wrap>{e.text}</Badge>");
  });
});

describe("los componentes de cliente no importan el cargador del servidor", () => {
  it("de lib/return-manifest-access solo tipos", () => {
    for (const file of ["components/return-manifests.tsx", "components/return-manifest-detail.tsx", "components/dispatch-day-board.tsx", "components/grupo-gf-courier.tsx", "components/order-drawer.tsx"]) {
      const src = read(file);
      for (const m of src.matchAll(/^import (.*) from "@\/lib\/return-manifest-access";$/gm)) expect(m[1]).toMatch(/^type /);
    }
  });
});
