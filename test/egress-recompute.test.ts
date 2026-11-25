import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SELLOS_DE_LECTURA, cambiosMateriales, soloSellos } from "@/lib/aliclik-snapshot-diff";
import { ttlCache } from "@/lib/ttl-cache";

/**
 * El egress de Supabase: 333 GB sobre 250 en un ciclo.
 *
 * MEDIDO (10-09-2026, 24 horas). 45.000 recálculos del Master; 2.000 por hora
 * de madrugada sin nadie conectado; 33 millones de filas de `cost_tariffs`
 * servidas —745 tarifas descargadas en CADA recálculo—. Detrás: el barrido de
 * Aliclik relee cada 20 minutos las guías de 14 días, y un snapshot IGUAL al
 * último aplicado pasaba la guarda monotónica (que descarta los más viejos, no
 * los iguales), se escribía entero y recalculaba. 1.200 guías reales, 43.000
 * aplicaciones.
 *
 * Dos cortes: no recalcular cuando el snapshot no cambia nada, y recordar las
 * tarifas unos minutos por instancia.
 */

const read = (...p: string[]) => readFileSync(resolve(process.cwd(), ...p), "utf8");

describe("¿el snapshot cambia algo?", () => {
  const fila = {
    delivery_status: "en_ruta",
    status_category: "in_route",
    reported_status: "DELIVERING · PICKED · CONFIRMED",
    reported_collect_amount: 89,
    last_report_at: "2026-09-09T10:00:00.000Z",
    api_report_at: "2026-09-09T10:00:00.000Z",
    api_updated_at: "2026-09-09T09:00:00.000Z",
    pickup_state: null,
  };

  it("un snapshot idéntico solo mueve los sellos de lectura: no es un cambio", () => {
    const patch = {
      ...fila,
      last_report_at: "2026-09-10T10:00:00.000Z",
      api_report_at: "2026-09-10T10:00:00.000Z",
      api_updated_at: "2026-09-09T09:00:00.000Z",
    };
    expect(cambiosMateriales(patch, fila)).toEqual([]);
    expect(soloSellos(patch)).toEqual({
      last_report_at: "2026-09-10T10:00:00.000Z",
      api_report_at: "2026-09-10T10:00:00.000Z",
      api_updated_at: "2026-09-09T09:00:00.000Z",
    });
  });

  it("un estado distinto sí es un cambio, y dice cuál", () => {
    expect(cambiosMateriales({ ...fila, delivery_status: "entregado" }, fila)).toEqual(["delivery_status"]);
  });

  it("el monto llega como texto o como número: es el mismo monto", () => {
    expect(cambiosMateriales({ reported_collect_amount: "89" }, fila)).toEqual([]);
    expect(cambiosMateriales({ reported_collect_amount: 90 }, fila)).toEqual(["reported_collect_amount"]);
  });

  it("un campo que la fila no trae se cuenta como cambio: ante la duda, se aplica", () => {
    // Si alguien añade una columna al parche y olvida traerla en COLUMNS, el
    // sistema vuelve a aplicar siempre —lo caro— en vez de no aplicar nunca.
    expect(cambiosMateriales({ closed_at: "2026-09-10T00:00:00.000Z" }, fila)).toEqual(["closed_at"]);
  });

  it("null y ausente son lo mismo para un sello: no se inventa un cambio", () => {
    expect(cambiosMateriales({ pickup_state: null }, fila)).toEqual([]);
    expect(SELLOS_DE_LECTURA).toEqual(["last_report_at", "api_report_at", "api_updated_at"]);
  });

  // Medido el 25-11-2026: las 735 guías ENTREGADAS de la ventana del barrido se reescribían enteras y su
  // pedido se recalculaba en cada pasada (247.723 veces en 10 días, unas 23.800 al día: cerca del 83 % de
  // los recálculos del Master), y solo 3 de esos 735 pedidos habían cambiado en tres horas. El parche lleva
  // `closed_at` con el formato de JavaScript (`…Z`) y la base lo devuelve con el suyo (`…+00:00`): el mismo
  // instante, comparado como texto, salía distinto siempre.
  it("un instante escrito de dos maneras es el mismo instante: una entregada no se reescribe en cada pasada", () => {
    const entregada = {
      ...fila,
      delivery_status: "entregado",
      status_category: "closed",
      delivered_source: "aliclik_api",
      closed_at: "2026-09-09T09:00:00+00:00",
    };
    const patch = { ...entregada, closed_at: "2026-09-09T09:00:00.000Z", api_report_at: "2026-09-10T10:00:00.000Z" };
    expect(cambiosMateriales(patch, entregada)).toEqual([]);
    // Con milisegundos y con otra zona horaria, igual.
    expect(cambiosMateriales({ closed_at: "2026-09-09T09:00:00.123Z" }, { closed_at: "2026-09-09T09:00:00.123+00:00" })).toEqual([]);
    expect(cambiosMateriales({ closed_at: "2026-09-09T09:00:00.000Z" }, { closed_at: "2026-09-09T04:00:00-05:00" })).toEqual([]);
  });

  it("otro instante sí es un cambio, y lo que no es una fecha y hora se sigue comparando como texto", () => {
    expect(cambiosMateriales({ closed_at: "2026-09-09T09:00:01.000Z" }, { closed_at: "2026-09-09T09:00:00+00:00" })).toEqual(["closed_at"]);
    expect(cambiosMateriales({ closed_at: "2026-09-09T09:00:00.000Z" }, { closed_at: null })).toEqual(["closed_at"]);
    // Un día suelto no es un instante: no se interpreta.
    expect(cambiosMateriales({ dia: "2026-09-09" }, { dia: "2026-09-09T00:00:00+00:00" })).toEqual(["dia"]);
    // Una etiqueta que parece otra no se toca.
    expect(cambiosMateriales({ reported_status: "DELIVERED" }, { reported_status: "delivered" })).toEqual(["reported_status"]);
  });
});

describe("el aplicador no recalcula lo que no cambió", () => {
  const src = read("lib/aliclik-track.ts");
  const start = src.indexOf("export async function applyAliclikSnapshot(");
  const fn = src.slice(start, src.indexOf("\n}\n", start));

  it("compara el parche con la fila ANTES de escribir, y sale sin recálculo", () => {
    const corte = fn.indexOf("if (!cambiosMateriales(patch, shipment as unknown as Record<string, unknown>).length) {");
    const escritura = fn.indexOf('await admin.from("shipments").update(patch).eq("id", shipment.id);');
    const recalculo = fn.indexOf("await recomputeOrderMasterSafe(admin, [shipment.order_id]);");
    expect(corte).toBeGreaterThan(-1);
    expect(corte).toBeLessThan(escritura);
    expect(escritura).toBeLessThan(recalculo);
    expect(fn).toContain('.update(soloSellos(patch)).eq("id", shipment.id);');
    expect(fn).toContain('return { ok: true, outcome: "unchanged", shipmentId: shipment.id, orderId: shipment.order_id };');
  });

  it("la fila trae TODO lo que el parche puede tocar, o la comparación no puede decidir", () => {
    // Cada clave que el parche escribe tiene que venir en COLUMNS. Si falta una,
    // «ante la duda se aplica» y volvemos a pagar el recálculo en cada pasada.
    const columnas = fn.match(/const COLUMNS =\s*([\s\S]*?);/)?.[1] ?? "";
    const claves = [
      "delivery_status",
      "status_category",
      "reported_status",
      "reported_collect_amount",
      "pickup_state",
      "returned_at",
      "returned_source",
      "closed_at",
      "delivered_source",
      "dispatched_at",
      "preparation_state",
      "ready_at",
      "custody_state",
      "custody_transferred_at",
      "external_order_number",
    ];
    for (const clave of claves) expect(columnas, clave).toContain(clave);
  });
});

describe("las tarifas se recuerdan", () => {
  it("dentro de la caducidad no vuelve a cargar; pasada, sí; otra clave, sí", async () => {
    const cache = ttlCache<number[]>(1000);
    let cargas = 0;
    const load = async () => {
      cargas++;
      return [cargas];
    };
    expect(await cache.get("org-a", 0, load)).toEqual([1]);
    expect(await cache.get("org-a", 999, load)).toEqual([1]);
    expect(await cache.get("org-b", 999, load)).toEqual([2]);
    expect(await cache.get("org-b", 2000, load)).toEqual([3]);
    cache.clear();
    expect(await cache.get("org-b", 2001, load)).toEqual([4]);
    expect(cargas).toBe(4);
  });

  it("el Master las lee por la memoria, con cinco minutos de vida", () => {
    const src = read("lib/order-master.ts");
    expect(src).toContain("export const TARIFF_CACHE_MS = 5 * 60_000;");
    expect(src).toContain('const cacheKey = [...orgIds].sort().join(",");');
    expect(src).toContain("const tariffs = await tariffCache.get(cacheKey, Date.now(), async () => {");
    expect(src).toContain('.from("cost_tariffs")');
    // El Tarifario de Grupo GF (mom-v1.31), con la misma memoria y la misma clave.
    expect(src).toContain("const gfTariffCache = ttlCache<GfTariffBook>(TARIFF_CACHE_MS);");
    expect(src).toContain("out.gfTariffs = await gfTariffCache.get(cacheKey, Date.now(), () => loadGfTariffBook(admin, orgIds));");
  });
});
