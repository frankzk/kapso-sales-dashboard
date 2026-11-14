// Lo que hace en la base el trigger `import_delivery_lines_sync` de la 0343
// (MOM §45.14), para las pruebas con la base falsa: los totales de cada
// producto (`received_qty`, `damaged_qty`, `reception_note`, `received_at`,
// `received_by`) son la suma de sus entregas; un producto que tuvo entregas y
// ya no tiene ninguna queda con los totales nulos. Un producto que nunca tuvo
// una línea no se toca (como el trigger: solo recalcula los productos de las
// líneas que cambian). El trigger real lo prueba scripts/sql/compras_locales_smoke.sql.
//
// No es un archivo de pruebas (no termina en .test.ts): lo importan.

import type { FakeDb } from "./woocommerce-fake-db";

export function withDeliveryTrigger(db: FakeDb): FakeDb {
  const touched = new Set<string>();
  const sync = () => {
    const lines = db.rows("import_delivery_lines");
    const deliveries = new Map(db.rows("import_deliveries").map((d) => [String(d.id), d]));
    for (const l of lines) touched.add(String(l.item_id));
    for (const item of db.rows("import_items")) {
      const id = String(item.id);
      if (!touched.has(id)) continue;
      const mine = lines
        .filter((l) => String(l.item_id) === id)
        .sort((a, b) => String(deliveries.get(String(a.delivery_id))?.delivered_on ?? "").localeCompare(String(deliveries.get(String(b.delivery_id))?.delivered_on ?? "")));
      if (!mine.length) {
        Object.assign(item, { received_qty: null, damaged_qty: null, reception_note: null, received_at: null, received_by: null });
        continue;
      }
      const last = deliveries.get(String(mine[mine.length - 1]!.delivery_id));
      const notes = mine.map((l) => String(l.note ?? "").trim()).filter(Boolean);
      Object.assign(item, {
        received_qty: mine.reduce((a, l) => a + Number(l.received), 0),
        damaged_qty: mine.reduce((a, l) => a + Number(l.damaged ?? 0), 0),
        reception_note: notes.length ? notes.join(" · ").slice(0, 300) : null,
        received_at: last?.created_at ?? "2026-11-14T15:00:00Z",
        received_by: last?.by_user ?? null,
      });
    }
  };
  db.afterWrite = (table) => {
    if (table === "import_delivery_lines" || table === "import_deliveries") sync();
  };
  sync();
  return db;
}
