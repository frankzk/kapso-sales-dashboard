// El celular en grande en la pestaña Chatby (owner, 26-10-2026, MOM §… «El
// celular en grande»): letra grande, agrupado de a tres y «Copiar celular».
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/dashboard/pedidos/actions", () => ({ loadOrderChatby: vi.fn() }));

import { ChatbyPhone } from "@/components/order-chatby-panel";

describe("ChatbyPhone", () => {
  it("un celular peruano se ve agrupado de a tres y con «Copiar celular»", () => {
    const html = renderToStaticMarkup(createElement(ChatbyPhone, { phone: "51973972968" }));
    expect(html).toContain("+51 973 972 968");
    expect(html).toContain("Copiar celular");
    expect(html).toContain("text-2xl");
  });

  it("otro formato se ve tal cual", () => {
    const html = renderToStaticMarkup(createElement(ChatbyPhone, { phone: "+1 555 0100" }));
    expect(html).toContain("+1 555 0100");
  });

  it("sin celular no pinta nada", () => {
    expect(renderToStaticMarkup(createElement(ChatbyPhone, { phone: null }))).toBe("");
  });

  it("la ficha le pasa el celular del pedido y el MOM lo dice", () => {
    const drawer = readFileSync(resolve(process.cwd(), "components/order-drawer.tsx"), "utf8");
    expect(drawer).toContain("phone={detail.row.customer_phone ?? null}");
    const mom = readFileSync(resolve(process.cwd(), "docs/mom/master-pedidos-v1.md"), "utf8");
    expect(mom).toContain("**El celular en grande (26-10-2026, owner):**");
  });
});
