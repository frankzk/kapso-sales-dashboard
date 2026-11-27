// Correo · Resend (MOM §46), pintado: la clave nunca aparece (solo su final),
// cada tienda muestra sus tres tramos con la cifra, «Subir a Resend» se apaga
// sin clave o sin `data.export`, y fuera de producción no se puede guardar.
// Las acciones van simuladas: aquí no sale nada a la red.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/app/dashboard/automatizaciones/correo/actions", () => ({
  saveResendKey: vi.fn(),
  removeResendKey: vi.fn(),
  uploadResendBucket: vi.fn(),
}));

import { ResendPanel } from "@/components/resend-panel";
import type { ResendOrgView } from "@/lib/resend-marketing-server";

function org(over: Partial<ResendOrgView> = {}): ResendOrgView {
  return {
    id: "org1",
    name: "Aurela + Kenku",
    keyHint: "re_…a1b2",
    keyUpdatedAt: "2026-11-25T15:00:00Z",
    canExport: true,
    stores: [
      { id: "s-kenku", name: "Kenku Peru", counts: { "6m": 5724, "9m": 9188, "12m": 11532, todos: 42903 }, topicReady: true, segmentsReady: ["6m", "12m", "todos"] },
    ],
    imports: [
      {
        id: "i1",
        storeName: "Kenku Peru",
        bucket: "6m",
        rows: 5724,
        excluded: 12,
        status: "completada",
        detail: "5.700 nuevos · 24 actualizados",
        createdAt: "2026-11-25T15:10:00Z",
        createdBy: "frankz",
      },
    ],
    ...over,
  };
}

const render = (orgs: ResendOrgView[], writable = true) => renderToStaticMarkup(createElement(ResendPanel, { orgs, writable }));

describe("ResendPanel", () => {
  it("muestra el final de la clave, los tres tramos con su cifra y la importación", () => {
    const html = render([org()]);
    expect(html).toContain("re_…a1b2");
    expect(html).toContain("Conectado");
    expect(html).toContain("Pidieron en los últimos 6 meses");
    expect(html).toContain("Pidieron en los últimos 9 meses");
    expect(html).toContain((9188).toLocaleString("es-PE"));
    expect(html).toContain("Pidieron en los últimos 12 meses");
    expect(html).toContain("Todos los que aceptan publicidad");
    expect(html).toContain((5724).toLocaleString("es-PE"));
    expect(html).toContain((42903).toLocaleString("es-PE"));
    expect(html).toContain("5.700 nuevos · 24 actualizados");
    expect(html).toContain("/dashboard/automatizaciones/correo/csv?store=s-kenku&amp;bucket=6m");
    expect(html).toContain('type="password"');
  });

  it("sin clave, «Subir a Resend» no se puede pulsar y lo explica", () => {
    const html = render([org({ keyHint: null, keyUpdatedAt: null })]);
    expect(html).toContain("Sin conectar");
    expect(html).toContain("Primero guarda la clave de Resend.");
    expect(html).not.toContain("Quitar clave");
    expect(html.match(/<button[^>]*disabled=""[^>]*>Subir a Resend/g)).toHaveLength(4);
  });

  it("sin `data.export`, no hay subir ni descargar", () => {
    const html = render([org({ canExport: false })]);
    expect(html).toContain("Descargar la base de pedidos");
    expect(html).not.toContain("Descargar CSV");
    expect(html.match(/<button[^>]*disabled=""[^>]*>Subir a Resend/g)).toHaveLength(4);
  });

  it("fuera de producción avisa y no deja guardar", () => {
    const html = render([org()], false);
    expect(html).toContain("Solo en producción");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Guardar clave/);
  });
});
