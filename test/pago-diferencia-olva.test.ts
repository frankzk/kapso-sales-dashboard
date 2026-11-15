// «Cotejar Olva» se muda entera a «Pago de diferencia» (owner, 10-11-2026,
// MOM §12 y §44): tres vistas en la misma página, el menú sin entrada propia y
// el permiso de vincular el de siempre («Gestionar pedidos»).
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    createElement("a", { href, ...rest }, children as never),
}));

import { PagoDiferenciaPage, pagoDiferenciaView } from "@/components/pago-diferencia-page";
import { navItems } from "@/components/sidebar";

const read = (p: string) => readFileSync(p, "utf8");

describe("«Cotejar Olva» dentro de «Pago de diferencia»", () => {
  it("la vista sale de la URL; lo que no se entiende es la bandeja", () => {
    expect(pagoDiferenciaView(undefined)).toBe("bandeja");
    expect(pagoDiferenciaView("olva")).toBe("olva");
    expect(pagoDiferenciaView("correos")).toBe("correos");
    expect(pagoDiferenciaView("otra")).toBe("bandeja");
  });

  it("tres pestañas con enlace, la activa marcada y el número de Olva por vincular", () => {
    const html = renderToStaticMarkup(
      createElement(PagoDiferenciaPage, {
        active: "olva",
        description: "x",
        counts: { olva: 7 },
        children: createElement("p", null, "cuerpo"),
      }),
    );
    expect(html).toContain('href="/dashboard/pedidos/pago-diferencia"');
    expect(html).toContain('href="/dashboard/pedidos/pago-diferencia?vista=olva"');
    expect(html).toContain('href="/dashboard/pedidos/pago-diferencia?vista=correos"');
    expect(html).toMatch(/aria-current="page"[^>]*>.*Cotejar Olva/);
    expect(html).toContain(">7<");
    expect(html).toContain("Pago de diferencia");
  });

  it("el menú ya no tiene «Cotejar Olva» y el número de Olva va en «Pago de diferencia»", () => {
    const hrefs = [...navItems(false, true, true), ...navItems(true, true, true)].map((i) => i.href);
    expect(hrefs).not.toContain("/dashboard/olva");
    expect(hrefs).toContain("/dashboard/pedidos/pago-diferencia");
    expect(read("app/dashboard/layout.tsx")).toContain('{ "/dashboard/pedidos/pago-diferencia": pagoDiferenciaBadge }');
    expect(read("app/dashboard/layout.tsx")).toContain("const pagoDiferenciaBadge = olvaPending + porRetornarCount;");
  });

  it("la ruta vieja lleva a la nueva, con su vista", () => {
    const old = read("app/dashboard/olva/page.tsx");
    expect(old).toContain('redirect(`/dashboard/pedidos/pago-diferencia?vista=${vista === "correos" ? "correos" : "olva"}`)');
  });

  it("vincular sigue pidiendo «Gestionar pedidos» y refresca la página nueva", () => {
    const actions = read("app/dashboard/olva/actions.ts");
    expect(actions).toContain('hasOrgPermission(orgId, "master.edit")');
    expect(actions).toContain('const PATH = "/dashboard/pedidos/pago-diferencia";');
    // «Cotejar ahora» entra al portal en la misma petición: la página da el tiempo.
    expect(read("app/dashboard/pedidos/pago-diferencia/page.tsx")).toContain("export const maxDuration = 120;");
  });

  it("los grupos de la bandeja van en control segmentado, no como otra fila de pestañas", () => {
    const tray = read("components/pago-diferencia-tray.tsx");
    expect(tray).toContain('aria-label="Grupo de pedidos"');
    expect(tray).toContain("rounded-lg bg-wash p-0.5");
    expect(tray).not.toContain("<h1");
  });

  it("el MOM lo documenta", () => {
    const mom = read("docs/mom/master-pedidos-v1.md");
    expect(mom).toMatch(/«Cotejar Olva» vive dentro de «Pago de\s+diferencia»/);
  });
});
