/**
 * «Asistidas»: las ventas que cerró otra asesora con una clienta con la que ELLA
 * ya había hablado (MOM §17.6, owner 17-11-2026). Pura.
 *
 * Por qué. #AUR900998 (16-11-2026): Antu llamó dos veces, habló con la clienta
 * y le mandó las fotos; tres horas después Medaly tomó el lead desde la búsqueda
 * y generó el pedido. La venta es de Medaly —la registró ella, `order_sales`, y
 * eso no cambia—, pero el trabajo de Antu no aparecía en ningún número. El owner
 * eligió «la venta se queda con quien la generó y se suma la columna Asistidas»
 * sobre repartirla a medias o dársela entera a la primera.
 *
 * La regla, para que no se mueva sola (lo que pasaba con «el último toque»):
 *   - solo cuentan llamadas firmadas (`lead_calls.kind = call`) en que la
 *     clienta CONTESTÓ y hubo conversación (`ASSIST_CONTACT_STATUSES`). Un «no
 *     responde», un buzón o un mensaje suelto no son haberla atendido;
 *   - en las `ASSIST_WINDOW_HOURS` horas ANTES de la venta, sobre el mismo lead;
 *   - de una asesora distinta de la que la generó. Si hubo varias, la asistida
 *     es de la PRIMERA que habló con ella en esa ventana: una sola por venta;
 *   - ventas desde el 01-11-2026 (hora de Lima), `ASSIST_FROM_ISO`.
 * Todo lo que mira es anterior a la venta, así que una vez hecha la venta su
 * asistida queda fija: nada de lo que pase después la cambia.
 */

/** El pedido de una asistida, como `WonOrderRef` de lib/productivity.ts. */
export type AssistOrderRef = { name: string | null; at: string | null };

/** Cuántas horas antes de la venta cuenta haber hablado con la clienta. */
export const ASSIST_WINDOW_HOURS = 72;

/** Desde cuándo se cuentan: 01-11-2026 00:00 en Lima (UTC−5). */
export const ASSIST_FROM_ISO = "2026-11-01T05:00:00.000Z";

/**
 * Los resultados de llamada en que la clienta contestó y se conversó
 * (lib/leads.ts). Fuera: no responde, buzón, cuelga, número que no existe y los
 * de cierre o pérdida.
 */
export const ASSIST_CONTACT_STATUSES: readonly string[] = [
  "contactado_dejo_wsp",
  "otros_productos",
  "casi_cierra",
  "volver_a_llamar",
  "yape_por_verificar",
  "sin_stock",
];

export type AssistSale = {
  vendedora: string;
  leadId: string | null;
  /** ISO del instante de la venta (`order_sales.occurred_at`). */
  occurredAt: string;
  net: number;
  orderName: string | null;
  orderAt: string | null;
};

export type AssistContact = {
  lead_id: string;
  vendedora: string | null;
  kind: string;
  new_status: string | null;
  occurred_at: string;
};

export type AssistCell = { asistidas: number; ingresos: number; detalle: AssistOrderRef[] };

const WINDOW_MS = ASSIST_WINDOW_HOURS * 3_600_000;

/** ¿Esta fila es una conversación con la clienta firmada por una asesora? */
export function isAssistContact(c: Pick<AssistContact, "vendedora" | "kind" | "new_status">): boolean {
  return !!c.vendedora && c.kind === "call" && !!c.new_status && ASSIST_CONTACT_STATUSES.includes(c.new_status);
}

/** Desde dónde hay que leer las llamadas para las ventas de un rango que empieza en `startIso`. */
export function assistContactsFromIso(startIso: string): string {
  const from = Math.max(Date.parse(startIso), Date.parse(ASSIST_FROM_ISO));
  return new Date(from - WINDOW_MS).toISOString();
}

/** Quién asistió esta venta, o null: la primera otra asesora que habló con la clienta en la ventana. */
export function saleAssister(sale: AssistSale, contactsOfLead: readonly AssistContact[]): string | null {
  const saleMs = Date.parse(sale.occurredAt);
  if (!sale.leadId || !Number.isFinite(saleMs) || saleMs < Date.parse(ASSIST_FROM_ISO)) return null;
  let best: { who: string; ms: number } | null = null;
  for (const c of contactsOfLead) {
    if (c.lead_id !== sale.leadId || !isAssistContact(c) || c.vendedora === sale.vendedora) continue;
    const ms = Date.parse(c.occurred_at);
    if (!Number.isFinite(ms) || ms >= saleMs || ms < saleMs - WINDOW_MS) continue;
    if (!best || ms < best.ms) best = { who: c.vendedora!, ms };
  }
  return best?.who ?? null;
}

/** Las asistidas de cada asesora para estas ventas. */
export function computeAssists(sales: readonly AssistSale[], contacts: readonly AssistContact[]): Map<string, AssistCell> {
  const byLead = new Map<string, AssistContact[]>();
  for (const c of contacts) {
    if (!isAssistContact(c)) continue;
    const list = byLead.get(c.lead_id);
    if (list) list.push(c);
    else byLead.set(c.lead_id, [c]);
  }
  const out = new Map<string, AssistCell>();
  for (const s of sales) {
    if (!s.leadId) continue;
    const who = saleAssister(s, byLead.get(s.leadId) ?? []);
    if (!who) continue;
    const cell = out.get(who) ?? { asistidas: 0, ingresos: 0, detalle: [] };
    cell.asistidas += 1;
    cell.ingresos += s.net;
    cell.detalle.push({ name: s.orderName, at: s.orderAt });
    out.set(who, cell);
  }
  for (const cell of out.values()) cell.detalle.sort((x, y) => ((x.at ?? "9999") < (y.at ?? "9999") ? -1 : 1));
  return out;
}
