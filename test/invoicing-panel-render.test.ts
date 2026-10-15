// El panel «Comprobante» del drawer, pintado (MOM §35.4, §35.7).
//
// Lo que se fija aquí: que «No está en SimpleFact: volver a intentar» no se
// pueda pulsar antes de `releaseAvailableAt` y diga desde qué hora de Lima se
// podrá, mientras «Sí está en SimpleFact: registrar su serie» sigue disponible;
// que sin saber desde cuándo está en duda tampoco se pueda (falla cerrada); y
// que fuera de producción (`canEmitNow` false) no haya «Emitir esta boleta»
// aunque llegara una oferta.
//
// Lo que decide el servidor (`releaseAvailableAt`, `canEmitNow`, la espera de
// `releaseDoubtfulInvoice`) se prueba en test/invoicing-drawer.test.ts y en
// test/invoicing-rules.test.ts; aquí solo lo que el panel hace con eso. Las
// acciones van simuladas: aquí no sale nada a la red.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/dashboard/pedidos/invoice-actions", () => ({
  confirmDoubtfulInvoice: vi.fn(),
  emitInvoiceAction: vi.fn(),
  loadInvoicePanel: vi.fn(),
  registerExternalInvoice: vi.fn(),
  releaseDoubtfulInvoice: vi.fn(),
  requestInvoiceRetry: vi.fn(),
}));

import type { InvoicePanelData, InvoicePanelRow } from "@/app/dashboard/pedidos/invoice-actions";
import { INVOICE_REASON_LABEL, INVOICE_RELEASE_UNKNOWN_TEXT, invoiceReleaseWaitText } from "@/lib/invoicing/rules";
import { OrderInvoicePanelView, invoicePanelView, releaseWaitText } from "@/components/order-invoice-panel";

const PANEL = readFileSync(resolve(process.cwd(), "components/order-invoice-panel.tsx"), "utf8");

const ORDER = "ord-1";
const INVOICE = "inv-1";
const RUC = "20556792829";
const ISSUER = "iss-1";

/** Se puede liberar desde las 15:16 de Lima del 14-10-2026. */
const AVAILABLE = "2026-10-14T20:16:00.000Z";
const WAIT =
  "Podrás liberarla desde las 15:16 (hora de Lima): SimpleFact puede tardar en mostrar una boleta que sí recibió.";

const SI = "Sí está en SimpleFact: registrar su serie";
const NO = "No está en SimpleFact: volver a intentar";
/** Un botón con ese texto, deshabilitado o no. */
const boton = (label: string, disabled: boolean) =>
  disabled
    ? new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`)
    : new RegExp(`<button(?![^>]*disabled="")[^>]*>${label}</button>`);

const row = (over: Partial<InvoicePanelRow> = {}): InvoicePanelRow => ({
  id: INVOICE,
  mode: "real",
  status: "en_duda",
  ruc: RUC,
  legalName: "GRUPO GF S.A.C.",
  total: 85,
  serie: null,
  correlative: null,
  pdfUrl: null,
  error: "SimpleFact no respondió.",
  note: null,
  createdAt: "2026-10-14T19:44:00.000Z",
  retryRequestedAt: null,
  manual: false,
  rucMismatch: false,
  items: null,
  releaseAvailableAt: AVAILABLE,
  ...over,
});

const panelData = (over: Partial<InvoicePanelData> = {}): InvoicePanelData => ({
  active: true,
  invoices: [row()],
  review: { state: "lista", ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "real", issuerId: ISSUER },
  check: null,
  creditNote: null,
  issuers: [{ id: ISSUER, ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "real" }],
  canManage: true,
  canEmitNow: true,
  emitNow: null,
  emitNowBlocked: null,
  ...over,
});

function pinta(data: InvoicePanelData): string {
  return renderToStaticMarkup(
    createElement(OrderInvoicePanelView, { orderId: ORDER, data, pending: false, run: async () => true }),
  );
}

/** El HTML como texto: sin etiquetas y con los espacios juntos. */
const texto = (html: string) =>
  html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T20:00:00.000Z")); // 15:00 de Lima
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Liberar un `en_duda` espera (§35.4) ──────────────────────────────────────

describe("«No está en SimpleFact: volver a intentar» espera a releaseAvailableAt", () => {
  // FIX: el panel ofrecía liberar un `en_duda` recién nacido. Un POST cortado
  // por tiempo puede haber llegado y SimpleFact tardar en listarlo: liberarlo y
  // volver a pulsar «Emitir esta boleta» son dos boletas a SUNAT. El servidor ya
  // no lo libera antes de tiempo; el panel no ofrece un botón que va a decir que
  // no, y dice desde qué hora se podrá.
  it("antes de la hora: deshabilitado y dice desde cuándo; registrar su serie, disponible", () => {
    const html = pinta(panelData());
    expect(html).toMatch(boton(NO, true));
    expect(html).toMatch(boton(SI, false));
    expect(texto(html)).toContain(WAIT);
    // El aviso describe al botón deshabilitado: un lector de pantalla lo lee con él.
    const id = /<button[^>]*aria-describedby="([^"]+)"[^>]*>No está en SimpleFact/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<p id="${id}"`);
  });

  it("un milisegundo antes sigue esperando; a la hora se puede, sin aviso", () => {
    vi.setSystemTime(new Date(Date.parse(AVAILABLE) - 1));
    expect(pinta(panelData())).toMatch(boton(NO, true));
    vi.setSystemTime(new Date(AVAILABLE));
    const html = pinta(panelData());
    expect(html).toMatch(boton(NO, false));
    expect(html).toMatch(boton(SI, false));
    expect(texto(html)).not.toContain("Podrás liberarla");
    expect(html).not.toContain("aria-describedby");
  });

  it("sin saber desde cuándo está en duda, no se libera (falla cerrada); registrar su serie, sí", () => {
    for (const releaseAvailableAt of [null, "", "no-es-fecha"]) {
      const html = pinta(panelData({ invoices: [row({ releaseAvailableAt })] }));
      expect(html, String(releaseAvailableAt)).toMatch(boton(NO, true));
      expect(html, String(releaseAvailableAt)).toMatch(boton(SI, false));
      expect(texto(html), String(releaseAvailableAt)).toContain(INVOICE_RELEASE_UNKNOWN_TEXT);
    }
  });

  it("quien no gestiona no ve ninguna de las dos, ni la espera", () => {
    const t = texto(pinta(panelData({ canManage: false })));
    expect(t).not.toContain(NO);
    expect(t).not.toContain(SI);
    expect(t).not.toContain("Podrás liberarla");
  });

  it("el formulario de liberar solo se abre mientras se puede, y el panel se repinta a la hora", () => {
    // Si el panel se relee con un `en_duda` que todavía espera, vuelven los botones.
    expect(PANEL).toContain(') : doubt === "liberar" && !releaseWait ? (');
    expect(PANEL).toContain("disabled={pending || releaseWait !== null}");
    // A la hora se vuelve a pintar solo: sin eso el botón seguía deshabilitado.
    expect(PANEL).toMatch(/setTimeout\(\(\) => setTick\(\(n\) => n \+ 1\), Math\.min\(ms \+ 250, 2_147_483_647\)\)/);
    expect(PANEL).toContain("}, [releaseAt, tick]);");
  });
});

describe("releaseWaitText", () => {
  it("dice la hora de Lima al minuto, la misma que dice el servidor", () => {
    const at = Date.parse(AVAILABLE);
    expect(releaseWaitText(AVAILABLE, at - 60_000)).toBe(WAIT);
    expect(releaseWaitText(AVAILABLE, at)).toBeNull();
    expect(releaseWaitText(AVAILABLE, at + 60_000)).toBeNull();
    // Pasada la medianoche de UTC sigue siendo el día anterior en Lima.
    for (const iso of ["2026-10-15T05:10:00.000Z", "2026-10-15T04:59:00.000Z", AVAILABLE]) {
      const hora = /desde las (\d\d:\d\d) /.exec(releaseWaitText(iso, 0) ?? "")?.[1];
      expect(hora, iso).toBeTruthy();
      // La misma hora que `invoiceReleaseWaitText`, la frase del servidor.
      expect(invoiceReleaseWaitText(iso), iso).toContain(`las ${hora} (hora de Lima)`);
    }
    expect(releaseWaitText("2026-10-15T05:10:00.000Z", 0)).toMatch(/^Podrás liberarla desde las 00:10 /);
  });

  it("falla cerrada: sin fecha o con una que no se entiende, no; con un reloj que no se entiende, espera", () => {
    expect(releaseWaitText(null, Date.parse(AVAILABLE) + 1)).toBe(INVOICE_RELEASE_UNKNOWN_TEXT);
    expect(releaseWaitText("mañana", Date.parse(AVAILABLE) + 1)).toBe(INVOICE_RELEASE_UNKNOWN_TEXT);
    expect(releaseWaitText(AVAILABLE, Number.NaN)).toBe(WAIT);
  });
});

// ── «Emitir esta boleta» solo en producción (§35.7) ──────────────────────────

describe("fuera de producción no hay «Emitir esta boleta»", () => {
  const OFERTA = { issuerId: ISSUER, ruc: RUC, legalName: "GRUPO GF S.A.C.", total: 85 };
  const manual = (over: Partial<InvoicePanelData> = {}) =>
    panelData({
      invoices: [],
      review: { state: "lista", ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "simulacion", issuerId: ISSUER },
      issuers: [{ id: ISSUER, ruc: RUC, legalName: "GRUPO GF S.A.C.", mode: "manual" }],
      emitNow: OFERTA,
      ...over,
    });
  const BOTON_EMITIR = /<button[^>]*>Emitir esta boleta<\/button>/;

  // FIX: el panel enseñaba el botón con solo `emitNow`. Una vista previa
  // comparte la base y la llave de cifrado con producción: el servidor ya no
  // manda la oferta ahí, y si llegara una, el panel tampoco la ofrece.
  it("con canEmitNow false, aunque llegue una oferta: ni botón ni «Lista para emitir»", () => {
    const view = invoicePanelView(manual({ canEmitNow: false }));
    expect(view.canEmitNow).toBe(false);
    expect(view.badge.label).not.toBe("Lista para emitir");
    expect(pinta(manual({ canEmitNow: false }))).not.toMatch(BOTON_EMITIR);
    // En producción, el mismo pedido sí lo lleva.
    expect(invoicePanelView(manual()).canEmitNow).toBe(true);
    expect(pinta(manual())).toMatch(BOTON_EMITIR);
  });

  it("y dice por qué, con la frase del servidor (`no_produccion`)", () => {
    const t = texto(
      pinta(manual({ canEmitNow: false, emitNow: null, emitNowBlocked: { reason: "no_produccion", detail: null } })),
    );
    expect(t).toContain(`«Emitir esta boleta» no está disponible: ${INVOICE_REASON_LABEL.no_produccion}`);
  });
});
