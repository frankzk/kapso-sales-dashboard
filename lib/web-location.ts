// La ubicación que trae el mensaje con que la clienta salta de la web al
// WhatsApp. Puro.
//
// Desde el 29-10-2026 el botón de WhatsApp de la ficha (WooCommerce) le pide
// a la clienta su departamento, provincia y distrito ANTES de abrir el chat, y
// los escribe en el mensaje que llega:
//
//   «Hola, quiero pedir <producto>. Soy de Lima / Lima / Santa Anita. https://…»
//
// Es un dato elegido de una lista, no escrito a mano: es la mejor pista de
// ubicación que tiene un lead que todavía no compró (MOM §11, cobertura de la
// cola). El lector del chat (`parseOrderSignals`) no lo veía: espera «soy de
// Arequipa» y las barras lo cortaban.

import { findDistrictOverride, type DistrictCoverageRule } from "@/lib/district-coverage";
import { normalizeCoverageLabel } from "@/lib/order-coverage";

export interface WebLocation {
  /** El departamento, tal como lo eligió («Lima», «Junín», «Callao»). */
  department: string;
  /** La provincia del INEI («Lima», «Huaral», «Tarma»). */
  province: string;
  district: string;
}

const PART = "([^/\\n]{2,60}?)";
const WEB_LOCATION_RE = new RegExp(
  `soy de\\s+${PART}\\s*/\\s*${PART}\\s*/\\s*${PART}(?=\\s*(?:\\.(?:\\s|$)|\\n|https?:|$))`,
  "i",
);

function clean(part: string): string {
  return part.replace(/\s+/g, " ").trim();
}

/** «Soy de Departamento / Provincia / Distrito», o null si el texto no lo trae. */
export function parseWebLocation(text: string | null | undefined): WebLocation | null {
  if (!text) return null;
  const m = WEB_LOCATION_RE.exec(text);
  if (!m) return null;
  const [department, province, district] = [m[1]!, m[2]!, m[3]!].map(clean);
  if (!department || !province || !district) return null;
  return { department, province, district };
}

/**
 * Cómo se guarda en el lead. La región, con la convención de los carritos de
 * Shopify que ya leen la cola y el Master («Lima» se distingue ahí):
 *
 *   - Lima / Lima / X      → «Lima (provincia)»: Lima Metropolitana.
 *   - Lima / Huaral / X    → «Lima (departamento)»: el resto del departamento.
 *   - Otro departamento    → ese departamento («Callao», «Junín»…).
 *
 * Y la provincia, la del INEI que eligió la clienta: es la que la ficha le pasa
 * a `order_coverage_for` cuando `peru_districts` no conoce el distrito, y la que
 * separa «Lima / Cañete / San Luis» del San Luis metropolitano.
 */
export function webLocationLeadFields(loc: WebLocation): { region: string; province: string; district: string } {
  let region = loc.department;
  if (normalizeCoverageLabel(loc.department) === "lima") {
    region = normalizeCoverageLabel(loc.province) === "lima" ? "Lima (provincia)" : "Lima (departamento)";
  }
  return { region, province: loc.province, district: loc.district.slice(0, 40) };
}

/**
 * La cobertura de la cola (Lima / Provincia) para esa ubicación. Exacta: la
 * provincia la eligió la clienta, no hay que adivinarla por el distrito. Las
 * excepciones de `district_coverage` mandan primero, igual que en el pedido y
 * en `coverageFromLocation` (Pucusana es de la provincia de Lima y va por
 * agencia).
 */
export function webLocationCoverage(
  loc: WebLocation,
  storeId: string,
  overrides: readonly DistrictCoverageRule[] = [],
): "lima" | "provincia" {
  const override = findDistrictOverride(overrides, storeId, loc.district);
  if (override) return override === "lima" ? "lima" : "provincia";
  const dept = normalizeCoverageLabel(loc.department);
  const province = normalizeCoverageLabel(loc.province);
  return dept.includes("callao") || (dept === "lima" && province === "lima") ? "lima" : "provincia";
}
