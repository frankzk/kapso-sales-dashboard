import { describe, expect, it } from "vitest";
import {
  closeOrderDrawerHref,
  masterOrderHref,
  orderDrawerHref,
  readOrderDrawerRequest,
  workspaceForDrawerSection,
} from "@/lib/order-drawer-href";

describe("orderDrawerHref", () => {
  it("abre la ficha sobre la pantalla actual y conserva los demás parámetros", () => {
    expect(orderDrawerHref("abc", "historial", { pathname: "/dashboard/despacho", search: "?tab=lista&rider=r1" }))
      .toBe("/dashboard/despacho?tab=lista&rider=r1&ficha=abc&seccion=historial");
  });

  it("sin sección explícita no añade `seccion` (Operar es lo normal)", () => {
    expect(orderDrawerHref("abc", null, { pathname: "/dashboard/courier", search: "" })).toBe("/dashboard/courier?ficha=abc");
    expect(orderDrawerHref("abc", "operar", { pathname: "/dashboard/courier" })).toBe("/dashboard/courier?ficha=abc");
  });

  it("reemplaza una ficha ya abierta en vez de acumular parámetros", () => {
    expect(orderDrawerHref("dos", "informacion", { pathname: "/dashboard/liquidaciones-2", search: "hoja=x&ficha=uno&seccion=historial" }))
      .toBe("/dashboard/liquidaciones-2?hoja=x&ficha=dos&seccion=informacion");
  });

  it("en el Master usa `abrir`, la convención propia de esa pantalla", () => {
    expect(orderDrawerHref("abc", "historial", { pathname: "/dashboard/pedidos", search: "q=KP1" }))
      .toBe("/dashboard/pedidos?q=KP1&abrir=abc&seccion=historial");
    expect(masterOrderHref("abc")).toBe("/dashboard/pedidos?abrir=abc");
  });

  it("no se pisa con `?pedido=`, que Grupo GF Courier usa para preseleccionar", () => {
    expect(orderDrawerHref("abc", null, { pathname: "/dashboard/courier", search: "pedido=abc" })).toBe("/dashboard/courier?pedido=abc&ficha=abc");
  });

  it("codifica el id", () => {
    expect(orderDrawerHref("a b/c", null, { pathname: "/dashboard/x" })).toBe("/dashboard/x?ficha=a+b%2Fc");
  });
});

describe("closeOrderDrawerHref", () => {
  it("quita solo la ficha y su sección", () => {
    expect(closeOrderDrawerHref({ pathname: "/dashboard/despacho", search: "?tab=lista&ficha=abc&seccion=historial&rider=r1" }))
      .toBe("/dashboard/despacho?tab=lista&rider=r1");
    expect(closeOrderDrawerHref({ pathname: "/dashboard/despacho", search: "ficha=abc" })).toBe("/dashboard/despacho");
  });
});

describe("readOrderDrawerRequest", () => {
  it("lee pedido y sección, con «operar» por defecto y ante secciones raras", () => {
    expect(readOrderDrawerRequest({ pathname: "/dashboard/despacho", search: "ficha=abc&seccion=historial" })).toEqual({ orderId: "abc", section: "historial" });
    expect(readOrderDrawerRequest({ pathname: "/dashboard/despacho", search: "ficha=abc" })).toEqual({ orderId: "abc", section: "operar" });
    expect(readOrderDrawerRequest({ pathname: "/dashboard/despacho", search: "ficha=abc&seccion=lo-que-sea" })).toEqual({ orderId: "abc", section: "operar" });
  });

  it("no actúa en el Master ni sin `ficha`", () => {
    expect(readOrderDrawerRequest({ pathname: "/dashboard/pedidos", search: "ficha=abc" })).toBeNull();
    expect(readOrderDrawerRequest({ pathname: "/dashboard/pedidos/", search: "ficha=abc" })).toBeNull();
  });

  it("sí actúa en las subrutas del Master, que no montan la tabla (Despacho del día vive en /dashboard/pedidos/despacho)", () => {
    expect(readOrderDrawerRequest({ pathname: "/dashboard/pedidos/despacho", search: "tab=lista&ficha=abc&seccion=historial" })).toEqual({ orderId: "abc", section: "historial" });
    expect(orderDrawerHref("abc", "historial", { pathname: "/dashboard/pedidos/despacho", search: "tab=lista" })).toBe("/dashboard/pedidos/despacho?tab=lista&ficha=abc&seccion=historial");
    expect(readOrderDrawerRequest({ pathname: "/dashboard/despacho", search: "tab=lista" })).toBeNull();
    expect(readOrderDrawerRequest({ pathname: "/dashboard/despacho", search: "ficha=%20" })).toBeNull();
  });
});

describe("workspaceForDrawerSection", () => {
  it("traduce el nombre de la URL a la pestaña de la ficha", () => {
    expect(workspaceForDrawerSection("historial")).toBe("actividad");
    expect(workspaceForDrawerSection("informacion")).toBe("informacion");
    expect(workspaceForDrawerSection("operar")).toBe("operar");
    expect(workspaceForDrawerSection(null)).toBe("operar");
  });
});
