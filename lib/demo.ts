// Deterministic demo-data generator (pure, no DB). Used by scripts/seed.ts and
// covered by tests. Produces linked orders ↔ conversations so every family of
// metrics has something realistic to show.

import type { ConversationRow, OrderRow } from "@/lib/types";

interface CatalogItem {
  title: string;
  sku: string;
  price: number;
  pid: string;
  vid: string;
}

const CATALOG: CatalogItem[] = [
  { title: "Polo Aurela", sku: "POLO-1", price: 59.9, pid: "1001", vid: "2001" },
  { title: "Gorro Lana", sku: "GORRO-1", price: 39.9, pid: "1002", vid: "2002" },
  { title: "Casaca Impermeable", sku: "CASACA-1", price: 159.9, pid: "1003", vid: "2003" },
  { title: "Zapatillas Urbanas", sku: "ZAP-1", price: 199.9, pid: "1004", vid: "2004" },
  { title: "Mochila Pro", sku: "MOCHILA-1", price: 89.9, pid: "1005", vid: "2005" },
];

// Small seedable PRNG so the demo is reproducible.
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface DemoOptions {
  storeId: string;
  days?: number;
  seed?: number;
  endDate?: Date;
  conversionRate?: number;
}

export interface DemoData {
  orders: OrderRow[];
  conversations: ConversationRow[];
}

export function generateDemoData(opts: DemoOptions): DemoData {
  const days = opts.days ?? 30;
  const rnd = mulberry32(opts.seed ?? 42);
  const end = opts.endDate ?? new Date();
  const conversion = opts.conversionRate ?? 0.32;

  const orders: OrderRow[] = [];
  const conversations: ConversationRow[] = [];
  let orderCounter = 0;

  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(end);
    day.setUTCDate(day.getUTCDate() - d);
    const convCount = 8 + Math.floor(rnd() * 18); // 8..25 per day

    for (let i = 0; i < convCount; i++) {
      const localHour = 8 + Math.floor(rnd() * 13); // 08:00..20:00 (Lima)
      const minute = Math.floor(rnd() * 60);
      // Lima is UTC-5: a local hour H maps to UTC H+5.
      const started = new Date(
        Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), localHour + 5, minute),
      );
      const convId = `seed-conv-${opts.storeId}-${d}-${i}`;
      conversations.push({
        store_id: opts.storeId,
        kapso_conversation_id: convId,
        phone_number_id: "seed-pn",
        started_at: started.toISOString(),
        status: rnd() < 0.85 ? "ended" : "active",
        message_count: 2 + Math.floor(rnd() * 15),
        last_message_at: started.toISOString(),
      });

      if (rnd() >= conversion) continue;

      orderCounter += 1;
      const itemCount = 1 + Math.floor(rnd() * 3);
      const lineItems = [];
      let subtotal = 0;
      for (let k = 0; k < itemCount; k++) {
        const p = CATALOG[Math.floor(rnd() * CATALOG.length)]!;
        const qty = 1 + Math.floor(rnd() * 2);
        lineItems.push({
          title: p.title,
          sku: p.sku,
          quantity: qty,
          price: p.price,
          product_id: p.pid,
          variant_id: p.vid,
        });
        subtotal += p.price * qty;
      }
      const promo = rnd() < 0.3;
      const stock = rnd() < 0.15;
      const cod = rnd() < 0.6;
      const tags = ["kapso", "whatsapp"];
      if (promo) tags.push("promo-whatsapp");
      if (stock) tags.push("stock-por-validar");
      const created = new Date(started.getTime() + (5 + Math.floor(rnd() * 40)) * 60_000);
      const gross = round2(subtotal * (promo ? 0.85 : 1));
      const cancelled = rnd() < 0.07; // COD orders get cancelled sometimes
      const refunded = !cancelled && rnd() < 0.06 ? round2(gross * 0.5) : 0;

      orders.push({
        store_id: opts.storeId,
        shopify_order_id: String(9_000_000_000 + orderCounter),
        name: `#${1000 + orderCounter}`,
        created_at: created.toISOString(),
        processed_at: created.toISOString(),
        updated_at: created.toISOString(),
        total_amount: gross,
        currency: "PEN",
        financial_status: cancelled ? "voided" : refunded > 0 ? "partially_refunded" : "paid",
        cancelled_at: cancelled ? new Date(created.getTime() + 3_600_000).toISOString() : null,
        total_refunded: refunded,
        tags,
        promo_applied: promo,
        stock_por_validar: stock,
        shipping_mode: cod ? "cod" : "agency",
        kapso_conversation_id: convId,
        line_items: lineItems,
      });
    }
  }

  return { orders, conversations };
}
