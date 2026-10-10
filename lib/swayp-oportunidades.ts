// Oportunidades Swayp: dónde mandar mercadería para destrabar pedidos
// (Stock Swayp, 10-10-2026, pedido del owner).
//
// LA PREGUNTA. «Por reponer» responde qué falta para las guías YA emitidas.
// Esta responde la de antes: ¿qué producto, en qué bodega de Swayp, dejaría
// salir pedidos que hoy esperan? Dos fuentes, las dos del Master:
//
//   - Repro Provincia (`gestion_reproprovincia`): el intento falló y el pedido
//     se puede reenviar por Swayp si la bodega de su ciudad tiene el producto.
//   - Por confirmar: provincia COD que el botón «Enviar por Swayp» (MOM §11.11)
//     despacharía sin esperar la confirmación, si hubiera stock. Misma regla que
//     el botón: Provincia COD, y no en «Swayp no entregó», que ya salió por
//     Swayp y se llama para salir por otra vía.
//
// SOLO CON DIRECCIÓN COMPLETA. Sin dirección, distrito y provincia no hay guía
// que emitir aunque llegue el stock; esos se cuentan aparte para que se vean.
//
// POR PRODUCTO, NO POR PEDIDO. `swayp_availability` (el filtro del Master) da
// un pedido por cubierto si ALGUNO de sus productos tiene stock, que es la
// regla de la cola. Una guía directa sale con el pedido completo, así que acá
// se mira cada producto (`evaluateDirectFenixStock` hace lo mismo al emitir), y
// la demanda se compara contra la cantidad: 1 unidad en bodega para 10 pedidos
// son 9 por mandar, no «hay stock».
//
// Este archivo es PURO: la página lee el Master, los productos y el stock, y
// esto los cruza.

import {
  ciudadSinControl,
  coverageCityOf,
  fenixStockCityKey,
  sinControlDeCantidad,
  stockCoversRef,
  type FenixStockRow,
} from "@/lib/fenix";
import { demandDepartment } from "@/lib/fenix-demand";
import { isFenixCity } from "@/lib/shipments";

export type OportunidadOrigen = "repro" | "por_confirmar";

export const OPORTUNIDAD_ORIGEN_LABEL: Record<OportunidadOrigen, string> = {
  repro: "Repro Provincia",
  por_confirmar: "Por confirmar",
};

/** Lo que la página lee de cada fila del Master. */
export interface OportunidadMasterRow {
  order_id: string;
  order_name: string | null;
  macro_stage: string | null;
  macro_substage: string | null;
  macro_since: string | null;
  coverage: string | null;
  address: string | null;
  district: string | null;
  province: string | null;
  region: string | null;
  order_total: number | string | null;
}

export interface OportunidadItem {
  title?: string | null;
  sku?: string | null;
  quantity?: number | null;
}

/** De dónde sale el pedido, o null si no es candidato. */
export function origenDeOportunidad(
  row: Pick<OportunidadMasterRow, "macro_stage" | "macro_substage" | "coverage">,
): OportunidadOrigen | null {
  if (row.macro_substage === "gestion_reproprovincia") return "repro";
  if (
    row.macro_stage === "por_confirmar" &&
    row.macro_substage !== "swayp_no_entrego" &&
    row.coverage === "provincia_cod"
  ) {
    return "por_confirmar";
  }
  return null;
}

const lleno = (s: string | null | undefined) => !!(s ?? "").trim();

/** Dirección, distrito y provincia (o departamento): lo mínimo para emitir la guía. */
export function direccionCompleta(
  row: Pick<OportunidadMasterRow, "address" | "district" | "province" | "region">,
): boolean {
  return lleno(row.address) && lleno(row.district) && (lleno(row.province) || lleno(row.region));
}

export interface OportunidadPedido {
  orderId: string;
  orderName: string | null;
  origen: OportunidadOrigen;
  /** Días en su etapa del Master. */
  dias: number | null;
  total: number;
  /** Unidades de ESTE producto que lleva el pedido. */
  unidades: number;
  /** Este es el único producto que le falta: con él, el pedido sale. */
  soloEste: boolean;
}

export interface OportunidadRow {
  /** Clave estable de la fila (ciudad + producto). */
  key: string;
  city: string;
  department: string;
  product: string;
  sku: string | null;
  /** Renglón de `fenix_stock` que la respalda; null si el producto no está anotado en esa bodega. */
  stockId: string | null;
  stock: number;
  /** Unidades que piden los pedidos candidatos. */
  unidades: number;
  /** Lo que hay que mandar: `unidades` menos lo que ya hay. */
  faltan: number;
  repro: number;
  porConfirmar: number;
  /** Pedidos a los que solo les falta este producto. */
  soloEste: number;
  /** Suma del total de los pedidos (un pedido con dos productos faltantes cuenta en las dos filas). */
  valor: number;
  pedidos: OportunidadPedido[];
}

export interface OportunidadesResumen {
  /** Pedidos candidatos con dirección completa y bodega Swayp en su ciudad, a los que les falta algo. */
  pedidos: number;
  repro: number;
  porConfirmar: number;
  /** Candidatos sin bodega Swayp en su ciudad: mandar mercadería no los destraba. */
  fueraDeCobertura: number;
  /** Candidatos sin dirección completa. */
  sinDireccion: number;
}

export interface Oportunidades {
  rows: OportunidadRow[];
  resumen: OportunidadesResumen;
}

const DAY_MS = 86_400_000;

function diasDesde(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/** El renglón de la bodega que corresponde a un producto: SKU exacto primero, luego el nombre. */
function renglonDe(cityRows: FenixStockRow[], item: OportunidadItem): FenixStockRow | undefined {
  const sku = (item.sku ?? "").trim().toLowerCase();
  const bySku = sku ? cityRows.find((r) => (r.sku ?? "").trim().toLowerCase() === sku) : undefined;
  return bySku ?? cityRows.find((r) => stockCoversRef(r, { title: item.title ?? null, sku: item.sku ?? null }));
}

/**
 * Cruza los pedidos candidatos con el stock. Devuelve una fila por ciudad y
 * producto donde la demanda supera lo que hay, ordenadas por pedidos que
 * destraba, después por unidades y por valor.
 */
export function buildSwaypOportunidades(
  stockRows: FenixStockRow[],
  master: OportunidadMasterRow[],
  itemsByOrder: ReadonlyMap<string, OportunidadItem[]>,
  now: Date = new Date(),
): Oportunidades {
  const resumen: OportunidadesResumen = { pedidos: 0, repro: 0, porConfirmar: 0, fueraDeCobertura: 0, sinDireccion: 0 };

  type Acc = Omit<OportunidadRow, "faltan" | "repro" | "porConfirmar" | "soloEste" | "valor" | "pedidos"> & {
    unlimited: boolean;
    pedidos: Omit<OportunidadPedido, "soloEste">[];
  };
  const acc = new Map<string, Acc>();
  // Por pedido, qué filas pide; sirve para saber a quién le falta solo una cosa.
  const keysByOrder = new Map<string, Set<string>>();
  const pedidoByOrder = new Map<string, OportunidadMasterRow & { origen: OportunidadOrigen }>();

  for (const row of master) {
    const origen = origenDeOportunidad(row);
    if (!origen) continue;
    if (!direccionCompleta(row)) {
      resumen.sinDireccion++;
      continue;
    }
    const city = coverageCityOf({ city: null, district: row.district, province: row.province ?? row.region });
    const stockCity = fenixStockCityKey(city);
    const cityRows = stockRows.filter((r) => fenixStockCityKey(r.city) === stockCity);
    if (!city || !(isFenixCity(city) || cityRows.length > 0)) {
      resumen.fueraDeCobertura++;
      continue;
    }
    // Sin control de cantidad (Lima): nunca falta nada.
    if (ciudadSinControl(city)) continue;

    const items = itemsByOrder.get(row.order_id) ?? [];
    if (!items.length) continue;
    const keys = new Set<string>();
    for (const item of items) {
      const title = (item.title ?? "").trim() || "(producto sin nombre)";
      const unidades = Math.max(1, Math.round(Number(item.quantity) || 1));
      const renglon = renglonDe(cityRows, item);
      const key = renglon ? `${stockCity}|${renglon.product.toLowerCase()}` : `${stockCity}|${title.toLowerCase()}`;
      let a = acc.get(key);
      if (!a) {
        a = {
          key,
          city: stockCity,
          department: demandDepartment(stockCity),
          product: renglon?.product ?? title,
          sku: renglon?.sku ?? item.sku ?? null,
          stockId: renglon?.id ?? null,
          stock: renglon ? renglon.quantity : 0,
          unlimited: renglon ? sinControlDeCantidad(renglon) : false,
          unidades: 0,
          pedidos: [],
        };
        acc.set(key, a);
      }
      a.unidades += unidades;
      const ya = a.pedidos.find((p) => p.orderId === row.order_id);
      if (ya) ya.unidades += unidades;
      else
        a.pedidos.push({
          orderId: row.order_id,
          orderName: row.order_name,
          origen,
          dias: diasDesde(row.macro_since, now),
          total: Number(row.order_total) || 0,
          unidades,
        });
      keys.add(key);
    }
    keysByOrder.set(row.order_id, keys);
    pedidoByOrder.set(row.order_id, { ...row, origen });
  }

  // Las filas donde falta: la demanda supera lo que hay.
  const faltantes = new Map<string, Acc & { faltan: number }>();
  for (const a of acc.values()) {
    if (a.unlimited) continue;
    const faltan = Math.max(0, a.unidades - Math.max(0, a.stock));
    if (faltan > 0) faltantes.set(a.key, { ...a, faltan });
  }

  const pedidosConFalta = new Set<string>();
  const rows: OportunidadRow[] = [];
  for (const f of faltantes.values()) {
    const pedidos: OportunidadPedido[] = f.pedidos.map((p) => {
      pedidosConFalta.add(p.orderId);
      const otras = [...(keysByOrder.get(p.orderId) ?? [])].filter((k) => k !== f.key && faltantes.has(k));
      return { ...p, soloEste: otras.length === 0 };
    });
    // Primero los que salen solo con esto, después los que llevan más tiempo esperando.
    pedidos.sort((a, b) => Number(b.soloEste) - Number(a.soloEste) || (b.dias ?? -1) - (a.dias ?? -1));
    rows.push({
      key: f.key,
      city: f.city,
      department: f.department,
      product: f.product,
      sku: f.sku,
      stockId: f.stockId,
      stock: f.stock,
      unidades: f.unidades,
      faltan: f.faltan,
      repro: pedidos.filter((p) => p.origen === "repro").length,
      porConfirmar: pedidos.filter((p) => p.origen === "por_confirmar").length,
      soloEste: pedidos.filter((p) => p.soloEste).length,
      valor: pedidos.reduce((n, p) => n + p.total, 0),
      pedidos,
    });
  }

  for (const id of pedidosConFalta) {
    const p = pedidoByOrder.get(id);
    if (!p) continue;
    resumen.pedidos++;
    if (p.origen === "repro") resumen.repro++;
    else resumen.porConfirmar++;
  }

  rows.sort(
    (a, b) =>
      b.pedidos.length - a.pedidos.length ||
      b.faltan - a.faltan ||
      b.valor - a.valor ||
      a.city.localeCompare(b.city) ||
      a.product.localeCompare(b.product),
  );
  return { rows, resumen };
}
