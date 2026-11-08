// @vitest-environment happy-dom
//
// «Cómo sale el pedido» en el cajón de Leads, montado de verdad (React + DOM),
// con las server actions simuladas (MOM §25.2). Lo que pinchan estas pruebas
// es el reporte del 08-11-2026: tras generar el pedido el bloque «se repetía»,
// el panel de Aliclik volvía vacío —sin la coordenada, sin la cotización, sin
// la nota— y «Crear guía en Aliclik» no llegaba a crear nada.
//
// La causa que se reproduce aquí: el cajón recarga el historial del lead a
// menudo (el sondeo de 12 s, volver a la pestaña, cualquier acción) y cada
// recarga traía un objeto nuevo. La tarjeta lo tomaba como «cambió» y releía
// las opciones; si la primera lectura había fallado —el pedido recién generado
// aún no está en el Master— el panel colgaba del aviso de error en OTRA
// posición del árbol que el de las opciones leídas, así que al releer React
// desmontaba el panel con lo escrito y montaba uno vacío.
//
// Sin datos de clientas: nombres, teléfonos y pedidos son de mentira.

import { act, createElement, useCallback, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Server actions y piezas ajenas al caso, simuladas ─────────────────────────
const mocks = vi.hoisted(() => ({
  loadChoices: vi.fn(),
  preview: vi.fn(),
  create: vi.fn(),
  poll: vi.fn(),
}));

vi.mock("@/app/dashboard/leads/post-order-actions", () => ({
  loadLeadPostOrderChoices: (leadId: string) => mocks.loadChoices(leadId),
}));
vi.mock("@/app/dashboard/pedidos/aliclik-actions", () => ({
  previewAliclikGuide: (...args: unknown[]) => mocks.preview(...args),
  createAliclikGuide: (...args: unknown[]) => mocks.create(...args),
  linkExistingAliclikGuide: vi.fn(async () => ({ error: "no" })),
}));
vi.mock("@/app/dashboard/pedidos/actions", () => ({
  loadOrderChatby: async () => ({ status: "sin_chatby" }),
  loadOrderGeo: vi.fn(),
  updateOrderGeo: vi.fn(),
}));
vi.mock("@/components/district-mismatch-warning", () => ({
  DISTRICT_MISMATCH_BLOCK_REASON: "Distrito por revisar.",
  DistrictMismatchWarning: () => null,
  useDistrictMismatchCheck: () => ({ mismatch: null, acknowledged: false, blocking: false, acknowledge() {}, reload() {} }),
}));
vi.mock("@/components/aliclik-duplicate-panel", async () => {
  const { useEffect } = await import("react");
  return {
    AliclikDuplicatePanel: ({ onGateChange }: { onGateChange?: (allowed: boolean) => void }) => {
      useEffect(() => onGateChange?.(true), [onGateChange]);
      return null;
    },
  };
});
vi.mock("@/components/aliclik-outlook", () => ({ AliclikOutlookBanner: () => null }));
vi.mock("@/components/pickup-key-panel", () => ({ PickupKeyPanel: () => null }));
vi.mock("@/components/direct-fenix-guide-modal", () => ({ DirectFenixGuideModal: () => null }));
vi.mock("@/components/swayp-desde-confirmacion-offer", () => ({ EnviarPorSwaypDesdeConfirmacion: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/app/dashboard/leads/actions", () => {
  const ok = () => vi.fn(async () => ({}));
  return {
    confirmLeadWon: ok(), createQuickReply: ok(), deleteQuickReply: ok(), generateOrder: ok(), registerCall: ok(),
    createWaMediaUpload: ok(), sendLeadMedia: ok(), sendLeadMessage: ok(), sendLeadTemplate: ok(), retryLeadMessage: ok(),
    probarAgenteLeadEnMiTelefono: ok(), assignYape: ok(), claimLead: ok(), passYape: ok(),
  };
});
vi.mock("@/lib/leads-read-client", () => ({
  listLeadTemplates: async () => [],
  listQuickReplies: async () => [],
  loadLeadConversation: async () => ({ messages: [], threads: [] }),
  loadLeadDeliveryCoverage: async () => ({ coverage: null }),
  loadOrderDraft: async () => ({}),
  pollLeadState: (leadId: string) => mocks.poll(leadId),
  searchStoreProducts: async () => [],
  loadLeadVoicePanel: async () => ({ error: "sin agente" }),
  listStoreVendedoras: async () => [],
  listYapeAlerts: async () => [],
}));
vi.mock("@/app/dashboard/leads/prepay-actions", () => ({ loadLeadPrepayStatus: async () => null }));
vi.mock("@/lib/supabase-browser", () => ({ createBrowserSupabase: () => ({}) }));

import { LeadDrawer, type LeadDrawerProps } from "@/components/leads-drawer";
import type { CustomerHistory } from "@/lib/leads-access";

// ── Datos de mentira ──────────────────────────────────────────────────────────
const LEAD_ID = "lead-prueba";
const ORDER_ID = "pedido-prueba";
const ORDER_NAME = "#KP000001";
const COORD = "-12.04318, -77.02824";
const NOT_IN_MASTER = "El pedido todavía no aparece en el Master. Vuelve a intentarlo en unos segundos.";

const choices = (over: { guide?: string | null; orderId?: string } = {}) => ({
  orderId: over.orderId ?? ORDER_ID,
  orderName: ORDER_NAME,
  aliclik: { offered: !over.guide, reason: null, guide: over.guide ?? null },
  swayp: { offered: false, reason: "Solo para provincia COD; este pedido es Lima.", guides: [] },
  agencia: {
    offered: false, reason: "No aplica en Lima.", mode: "optional", gatewayNote: null,
    shalomDestination: false, payment: null, shalom: null,
  },
});

/** Lo que devuelve el servidor: cada llamada, un objeto NUEVO con lo mismo. */
const server = { guide: null as string | null };
const history = (): CustomerHistory => ({
  orderCount: 0, lastOrderName: null, lastOrderAt: null, lastProduct: null,
  currentOrderName: ORDER_NAME, currentOrderId: ORDER_ID, currentOrderGuide: server.guide,
  currentOrderHasCoordinate: false,
  currentOrderAliclikHealth: { quote: "sin_monitoreo", create: "sin_datos" },
  recentOrders: [],
});
const lead = () => ({
  id: LEAD_ID, store_id: "tienda-prueba", name: "Clienta de prueba", phone: "51900000000", source: "organic",
  status: "ganado", category: "won", has_order: true, order_id: ORDER_ID,
  kapso_conversation_id: null, last_inbound_at: null, last_interaction_at: null,
}) as unknown as LeadDrawerProps["lead"];

// ── El cajón como lo monta Leads: `selected` + `history` y `refreshDetail` ─────
const refreshes = { count: 0 };
let refreshDrawer: () => void = () => {};
function LeadsLikeHost() {
  const [selected, setSelected] = useState(lead);
  const [hist, setHist] = useState<CustomerHistory | null>(null);
  const loaded = useRef(false);
  if (!loaded.current) {
    loaded.current = true;
    void Promise.resolve().then(() => setHist(history()));
  }
  // components/leads.tsx › refreshDetail sin argumento: relee el lead y su
  // historial y los vuelve a poner, aunque no haya cambiado nada.
  const refreshDetail = useCallback(() => {
    refreshes.count += 1;
    void (async () => {
      const next = Promise.resolve().then(history);
      await Promise.resolve();
      setSelected(lead());
      void next.then(setHist);
    })();
  }, []);
  refreshDrawer = refreshDetail;
  return createElement(LeadDrawer, {
    lead: selected, calls: [], history: hist, adMeta: null, waNumber: null, shopifyDomain: null, currency: "S/",
    onClose: () => {}, onRegistered: () => refreshDetail(),
  });
}

// ── Utilidades de DOM ─────────────────────────────────────────────────────────
let host: HTMLDivElement;
let root: Root;
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });
};
const headings = (text: string) => [...document.querySelectorAll("h3")].filter((h) => h.textContent === text);
const coordinateInputs = () => [...document.querySelectorAll<HTMLInputElement>("input[placeholder='Enlace de Google Maps o coordenada']")];
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
const noteInput = () => {
  const label = [...document.querySelectorAll("label")].find((l) => l.textContent?.startsWith("Nota para el courier"));
  return label?.querySelector("input") ?? null;
};
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function click(el: HTMLElement | undefined) {
  expect(el).toBeTruthy();
  await act(async () => el!.click());
  await settle();
}
/** El panel de Aliclik con la coordenada pegada, cotizado y con la nota escrita. */
async function quoteWithNote() {
  const [input] = coordinateInputs();
  await act(async () => type(input!, COORD));
  await click(button("Cotizar envío"));
  const note = noteInput();
  expect(note).toBeTruthy();
  await act(async () => type(note!, "Dejar en portería"));
  return input!;
}
/** Lo que pasa en el cajón sin que la asesora toque nada. */
async function backgroundRefreshes() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => refreshDrawer());
    await settle();
  }
  // Volver a la pestaña tras copiar la ubicación en WhatsApp: el sondeo del
  // cajón ve un cambio del lead y pide la recarga completa.
  mocks.poll.mockResolvedValueOnce({ hasOrder: true, status: "seguimiento", category: "won" });
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await settle();
}
function expectOneBlock() {
  expect(headings("Cómo sale el pedido")).toHaveLength(1);
  expect(headings("Crear guía en Aliclik").length).toBeLessThanOrEqual(1);
  expect(coordinateInputs().length).toBeLessThanOrEqual(1);
}

beforeEach(async () => {
  server.guide = null;
  refreshes.count = 0;
  mocks.loadChoices.mockReset().mockImplementation(async () => ({ choices: choices({ guide: server.guide }) }));
  mocks.preview.mockReset().mockResolvedValue({
    ok: true, orderName: ORDER_NAME, collectTotal: 59, orderTotal: 59,
    couriers: [{ transportId: 7, transportName: "AUDRIVER", deliveryCost: 16.5, returnCost: 8, addDays: 0, selectable: true }],
  });
  mocks.create.mockReset().mockImplementation(async () => {
    server.guide = "ALC000001";
    return { notice: "Guía ALC000001 creada." };
  });
  mocks.poll.mockReset().mockResolvedValue({ hasOrder: true, status: "ganado", category: "won" });
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(LeadsLikeHost)));
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
});

describe("«Cómo sale el pedido» en el cajón de Leads (MOM §25.2)", () => {
  it("un solo bloque, y las recargas de fondo no tocan el panel de Aliclik ni releen las opciones", async () => {
    expectOneBlock();
    expect(headings("Crear guía en Aliclik")).toHaveLength(1);
    const input = await quoteWithNote();
    const readsBefore = mocks.loadChoices.mock.calls.length;

    await backgroundRefreshes();

    expect(refreshes.count).toBeGreaterThanOrEqual(4);
    expectOneBlock();
    // El MISMO input (no uno nuevo vacío), con lo que se pegó; la cotización y la nota siguen.
    expect(coordinateInputs()[0]).toBe(input);
    expect(input.value).toBe(COORD);
    expect(noteInput()?.value).toBe("Dejar en portería");
    expect(button("Crear guía en Aliclik")).toBeTruthy();
    // Un historial nuevo con el mismo pedido y la misma guía no es motivo para
    // releer (cada lectura es una server action en cola delante de «Crear»).
    expect(mocks.loadChoices.mock.calls.length).toBe(readsBefore);
  });

  it("si la primera lectura falla (el pedido aún no está en el Master), el panel es el mismo cuando la lectura vuelve", async () => {
    await act(async () => root.unmount());
    mocks.loadChoices.mockReset()
      .mockResolvedValueOnce({ error: NOT_IN_MASTER })
      .mockImplementation(async () => ({ choices: choices({ guide: server.guide }) }));
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(LeadsLikeHost)));
    await settle();

    expect(document.body.textContent).toContain(NOT_IN_MASTER);
    expectOneBlock();
    const input = await quoteWithNote();

    await backgroundRefreshes();
    expect(coordinateInputs()[0]).toBe(input);
    expect(input.value).toBe(COORD);

    // «Intentar nuevamente»: ahora sí responde y aparecen las tres opciones…
    await click(button("Intentar nuevamente"));
    expect(document.body.textContent).not.toContain(NOT_IN_MASTER);
    const tiles = [...document.querySelectorAll("button[aria-pressed]")].map((b) => b.textContent ?? "");
    expect(tiles.filter((t) => t.startsWith("Guía Aliclik"))).toHaveLength(1);
    expectOneBlock();
    // …y el panel de debajo NO se reinicia: el mismo input, lo pegado, la nota.
    expect(coordinateInputs()[0]).toBe(input);
    expect(input.value).toBe(COORD);
    expect(noteInput()?.value).toBe("Dejar en portería");
  });

  it("«Crear guía en Aliclik» crea una vez, avisa al cajón una vez y deja el bloque de la guía", async () => {
    await quoteWithNote();
    await backgroundRefreshes();
    const before = refreshes.count;

    await click(button("Crear guía en Aliclik"));

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![0]).toBe(ORDER_ID);
    expect(mocks.create.mock.calls[0]![1]).toMatchObject({ transportId: 7, coordinate: COORD, note: "Dejar en portería" });
    // onCreated → la tarjeta relee y el cajón recarga lead + historial: una vez.
    expect(refreshes.count - before).toBe(1);
    expectOneBlock();
    expect(headings("Crear guía en Aliclik")).toHaveLength(0);
    expect(headings("Guía de Aliclik")).toHaveLength(1);
    expect(document.body.textContent).toContain("ALC000001");
  });

  it("si la lectura trae otro pedido, pide recargar la ficha una vez y no en bucle", async () => {
    await act(async () => root.unmount());
    mocks.loadChoices.mockReset().mockImplementation(async () => ({ choices: choices({ orderId: "otro-pedido" }) }));
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(LeadsLikeHost)));
    await settle();
    await backgroundRefreshes();

    expect(document.body.textContent).toContain("El pedido cambió. Actualizando la ficha…");
    // 4 recargas de fondo de la prueba + 1 pedida por la tarjeta, no una por relectura.
    expect(refreshes.count).toBe(5);
    expectOneBlock();
    expect(headings("Crear guía en Aliclik")).toHaveLength(0);
  });
});
