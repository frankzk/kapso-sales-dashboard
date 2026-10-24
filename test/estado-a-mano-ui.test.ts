// La ficha y el Master solo ofrecen «Registrar estado» a quien puede hacerlo:
// owner y admin (`master.set_status`, decisión del dueño del 15-10-2026, MOM
// §16). Lo que se fija aquí: sin el permiso, la tarjeta no se pinta y en su
// sitio queda una línea que dice quién lo hace; comentar, devolver y corregir
// vínculos siguen a la vista; y la barra de lote no ofrece «Registrar estado…».
// Ocultarlo no es la protección —la pone el servidor (estado-a-mano-solo-admin)—,
// pero ofrecer un botón que siempre rechaza es mandar a la gente a chocar.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { OrderActions } from "@/components/order-drawer";
import { BulkBar } from "@/components/orders-master";
import { REOPEN_HINT, SET_STATUS_ADMIN_NOTE, terminalOrderBlocker } from "@/lib/order-status";
import type { OrderMasterRow } from "@/lib/types";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const row = {
  order_id: "order-a",
  order_name: "#KP150001",
  store_id: "store-a",
  general_status: "en_proceso",
  operational_status: "en_ruta",
  coverage: "lima",
  guide_code: "AUR5X150001",
} as unknown as OrderMasterRow;

const noop = () => {};

function actions(canSetStatus: boolean): string {
  return renderToStaticMarkup(
    createElement(OrderActions, {
      row,
      canOverride: false,
      canSetStatus,
      pending: false,
      outputCount: 1,
      onStatus: noop,
      onComment: noop,
      onReturn: noop,
      onRelink: noop,
    }),
  );
}

function bulk(canSetStatus: boolean): string {
  return renderToStaticMarkup(
    createElement(BulkBar, {
      selectedIds: new Set(["order-a"]),
      orderNames: new Map([["order-a", "#KP150001"]]),
      orderCouriers: new Map(),
      visibleIds: ["order-a"],
      canEdit: true,
      canSetStatus,
      onClear: noop,
      onToggleRow: noop,
      onCreated: noop,
    }),
  );
}

describe("«Gestión manual» en la ficha", () => {
  it("owner y admin ven la tarjeta «Registrar estado»", () => {
    const html = actions(true);
    expect(html).toContain(">Registrar estado</h4>");
    expect(html).toContain("Guardar estado");
    expect(html).not.toContain(SET_STATUS_ADMIN_NOTE);
  });

  it("sin el permiso, la tarjeta no está y queda la línea que dice quién lo hace", () => {
    const html = actions(false);
    expect(html).not.toContain(">Registrar estado</h4>");
    expect(html).not.toContain("Guardar estado");
    expect(SET_STATUS_ADMIN_NOTE).toBe("Registrar el estado a mano lo hace un admin.");
    expect(html).toContain(SET_STATUS_ADMIN_NOTE);
  });

  it("y el resto de «Gestión manual» sigue: comentar, devolver, corregir vínculos", () => {
    const html = actions(false);
    expect(html).toContain("Gestión manual");
    expect(html).toContain("Añadir comentario");
    expect(html).toContain("Registrar devolución");
    expect(html).toContain("Corregir vínculo de guía");
  });

  it("la ficha recibe el permiso de las dos páginas que la montan, como los demás", () => {
    expect(read("app/dashboard/pedidos/page.tsx")).toContain('canSetStatus={perms.can("master.set_status")}');
    expect(read("app/dashboard/layout.tsx")).toContain('canSetStatus={permissions.can("master.set_status")}');
    expect(read("components/order-drawer-host.tsx")).toContain("canSetStatus={permissions.canSetStatus}");
    expect(read("components/orders-master.tsx")).toContain("canSetStatus={canSetStatus}");
    expect(read("components/order-drawer.tsx")).toContain("canSetStatus={canSetStatus}");
  });
});

describe("la barra de lote del Master", () => {
  it("ofrece «Registrar estado…» a owner y admin", () => {
    expect(bulk(true)).toContain("Registrar estado…");
  });

  it("a los demás no, y «Forzar courier…» sigue", () => {
    const html = bulk(false);
    expect(html).not.toContain("Registrar estado…");
    expect(html).toContain("Forzar courier…");
  });
});

describe("los avisos que mandan a «Registrar estado» dicen quién lo hace", () => {
  it("la reapertura de un pedido cerrado la hace un admin", () => {
    expect(REOPEN_HINT).toBe(
      "Lo vuelve a abrir un admin en «Gestión manual → Registrar estado», al final de la pestaña Operar del pedido.",
    );
    expect(terminalOrderBlocker("entregado")).toBe(`El pedido está entregado. ${REOPEN_HINT}`);
    expect(terminalOrderBlocker("anulado")).toContain("si lo anuló la tienda o el courier, lo vuelve a abrir un admin en «Gestión manual");
  });

  it("la entrega declarada de la Mesa de cierre también", () => {
    const desk = read("components/order-closure-desk.tsx").replace(/\s+/g, " ");
    expect(desk).toContain("el estado lo fija un admin en «Gestión manual»");
    expect(desk).not.toContain("con el courier y fija el estado");
  });
});
