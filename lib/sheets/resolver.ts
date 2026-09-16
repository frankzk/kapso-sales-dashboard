// Liquidaciones 2 — reglas derivadas puras: el resolver de Estatus del
// Consolidado, la zona, el mes y los intentos en Lima. Sin base de datos, sin
// React: se prueban solas (test/sheets-resolver.test.ts).
//
// El resolver reproduce la columna «Estatus» de la hoja «Revisar» del Excel:
//   Entregado > Devuelto > Anulado > Tránsito > Pendiente
// con una diferencia deliberada: «Anulado» solo lo pone Shopify. Un cancelado
// del courier cuenta como intento (T), porque el pedido sigue vivo (MOM §9.4).

import type { Contribution, ContributionMark, OrderFacts } from "./types";

export type ConsolidadoStatus = "entregado" | "devuelto" | "anulado" | "transito" | "pendiente";

export const CONSOLIDADO_LABEL: Record<ConsolidadoStatus, string> = {
  entregado: "Entregado",
  devuelto: "Devuelto",
  anulado: "Anulado",
  transito: "Tránsito",
  pendiente: "Pendiente",
};

export interface ConsolidadoResolution {
  status: ConsolidadoStatus;
  /** Hoja que decidió (la que aportó la E o la D). Null si nadie aportó. */
  by: string | null;
  /** Cuántas hojas marcaron T: los intentos que se contarán en Lima. */
  transitCount: number;
}

export function resolveConsolidado(
  contributions: readonly Contribution[],
  cancelled: boolean,
): ConsolidadoResolution {
  const first = (mark: ContributionMark) => contributions.find((c) => c.mark === mark) ?? null;
  const transitCount = contributions.filter((c) => c.mark === "T").length;
  const delivered = first("E");
  if (delivered) return { status: "entregado", by: delivered.sheet_key, transitCount };
  const returned = first("D");
  if (returned) return { status: "devuelto", by: returned.sheet_key, transitCount };
  if (cancelled) return { status: "anulado", by: null, transitCount };
  if (transitCount > 0) return { status: "transito", by: null, transitCount };
  return { status: "pendiente", by: null, transitCount };
}

/**
 * Lo que Kapta ya sabe del pedido, expresado como aporte. En la iteración 1
 * es el único aporte; las hojas de Reparto propio y Courier externo se suman
 * después con el mismo alfabeto. Un `general_status` de Kapta ya integra las
 * APIs de Aliclik, Shalom y Tanders, así que Provincia queda cubierta desde
 * el primer día (cruce del 16-09-2026).
 */
export function kaptaContribution(facts: OrderFacts): Contribution | null {
  const courier = facts.delivered_courier ?? facts.current_courier ?? null;
  const key = `kapta:${courier ?? "sin_courier"}`;
  switch (facts.general_status) {
    case "entregado":
      return { sheet_key: key, mark: "E" };
    case "devuelto":
      return { sheet_key: key, mark: "D" };
    case "en_proceso":
      return { sheet_key: key, mark: "T" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Zona
// ---------------------------------------------------------------------------
export const ZONAS = ["Lima Centrico", "Lima Periferica", "Provincia COD", "Provincia Sin COD"] as const;
export type Zona = (typeof ZONAS)[number];

/** Clave de comparación para distritos: sin acentos, sin espacios dobles, minúsculas. */
export function districtKey(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^[\s\-–]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Zona del pedido. Primero el catálogo (lo que la operación decidió distrito
 * por distrito); si el distrito no está, la cobertura que Kapta ya calcula
 * (`coverage`, 0130): Lima sin catálogo cae a Periférica, Provincia se parte
 * por si Aliclik llega (COD) o va por agencia (Sin COD).
 */
export function resolveZona(
  facts: Pick<OrderFacts, "district" | "region" | "coverage" | "shipping_mode">,
  catalog: (districtKey: string) => string | null,
): Zona | null {
  const fromCatalog = catalog(districtKey(facts.district));
  if (fromCatalog && (ZONAS as readonly string[]).includes(fromCatalog)) return fromCatalog as Zona;
  const region = districtKey(facts.region);
  const isLima = facts.coverage === "lima" || /\blima\b/.test(region) || /\bcallao\b/.test(region);
  if (isLima) {
    if (fromCatalog === "Provincia") return "Provincia COD";
    return "Lima Periferica";
  }
  if (facts.coverage === "provincia_cod") return "Provincia COD";
  if (facts.coverage === "agencia") return "Provincia Sin COD";
  if (facts.shipping_mode === "agency") return "Provincia Sin COD";
  if (facts.shipping_mode === "cod") return "Provincia COD";
  return null;
}

/**
 * Intentos en Lima: la columna «# de Motos Lima» del Excel. Solo cuenta
 * mientras el pedido siga abierto (pendiente o en tránsito) y sea de Lima; en
 * cualquier otro caso queda vacío para que no se sume donde no toca.
 */
export function intentosLima(status: ConsolidadoStatus, zona: string | null, transitCount: number): number | null {
  if (status !== "pendiente" && status !== "transito") return null;
  if (!zona || !zona.startsWith("Lima")) return null;
  return transitCount;
}

// ---------------------------------------------------------------------------
// Fechas en hora de Lima
// ---------------------------------------------------------------------------
const LIMA_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Lima",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `2026-09-16` para un instante ISO, en hora de Lima. Null si no parsea. */
export function limaDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return LIMA_DATE.format(d);
}

/** `2026/9`, como la columna «Mes» del Excel, para agrupar y filtrar. */
export function limaMonthKey(iso: string | null | undefined): string | null {
  const day = limaDate(iso);
  if (!day) return null;
  const [y, m] = day.split("-");
  return `${y}/${Number(m)}`;
}

/** Rango UTC de un mes de Lima: [inicio, fin). */
export function limaMonthRange(month: string): { from: string; to: string } | null {
  const m = /^(\d{4})\/(\d{1,2})$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  // Lima es UTC-5 todo el año.
  const from = new Date(Date.UTC(y, mo - 1, 1, 5, 0, 0)).toISOString();
  const to = new Date(Date.UTC(y, mo, 1, 5, 0, 0)).toISOString();
  return { from, to };
}
