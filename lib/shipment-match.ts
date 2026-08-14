// Pure matcher core: given a parsed report row and a set of candidate orders
// (already fetched from accessible stores), decide which order — if any — the
// Aliclik guide belongs to. Pure + tested; the DB wrapper lives in
// lib/aliclik-ingest.ts.

import { normalizeOrderName } from "./aliclik-import";

export type MatchMethod = "order_name" | "order_name_phone" | "phone" | "none";

/**
 * Lo mínimo que hace falta para emparejar una fila de reporte con un pedido.
 * Se define estructuralmente (en vez de atarlo a `ParsedShipmentRow`) para que
 * cualquier adaptador de courier —no solo el de Aliclik— pueda usar el mismo
 * emparejador. `ParsedShipmentRow` y `CanonicalReportRow` lo cumplen tal cual.
 */
export interface MatchableRow {
  order_name: string | null;
  order_name_confirmed: boolean;
  customer_phone: string | null;
  /** El código impreso. Cuando lleva dentro el nº de pedido, manda: ver abajo. */
  guide_code?: string | null;
}

/**
 * El número de pedido que el código impreso lleva dentro, si lo lleva.
 *
 * NO ES UNA CORAZONADA: medido sobre las 3.976 guías Aliclik con pedido
 * (2026-08-11). Al quitar el prefijo AUR5X quedan tres familias por longitud, y
 * se comportan de forma tajante:
 *
 *   12 dígitos — 2.841 guías, NINGUNA termina en el nº de su pedido.
 *    7 dígitos —    12 guías, NINGUNA. Ni una sola nombra un pedido existente.
 *    6 dígitos — 1.179 guías, 1.162 SÍ (98,6%).
 *
 * Las de doce y siete son identificadores de Aliclik; las de seis son el nº de
 * pedido que alguien tecleó al crear la guía en el portal. Por eso solo se
 * reconoce la familia de seis: en las otras dos, leer un pedido ahí dentro
 * sería leer ruido.
 *
 * FRÁGIL A PROPÓSITO, y documentado en el MOM §10.1: hoy los pedidos de la
 * operación son de seis dígitos (106620–127540). El día que lleguen al millón,
 * esta longitud deja de distinguir familia y hay que revisar la regla.
 */
export function orderRefInGuideCode(guideCode: string | null | undefined): string | null {
  const stripped = (guideCode ?? "").trim().toUpperCase().replace(/^AUR5X/, "");
  return /^\d{6}$/.test(stripped) ? stripped : null;
}

const orderDigits = (name: string | null | undefined) => (name ?? "").replace(/\D/g, "");

export interface OrderCandidate {
  id: string;
  store_id: string;
  name: string | null; // "#KP114985"
  customer_phone: string | null; // normalized
}

export interface MatchResult {
  order_id: string | null;
  store_id: string | null; // resolved store when matched
  matched: boolean;
  method: MatchMethod;
  // "review" when ambiguous (multiple candidates) or no confident match
  status: "matched" | "review";
}

/**
 * Match a parsed row against candidate orders.
 *   1) by order name (#KP…/#AUR…) — exact on the normalized name. A CONFIRMED
 *      name (literal "KP"/"AUR" token found) behaves as before: unique → match.
 *      If it's ambiguous (2+ orders share the name — rare), try to disambiguate
 *      by phone before giving up, same technique as the unconfirmed case below;
 *      only genuinely ambiguous (still 0 or 2+ after that) → review. An
 *      UNCONFIRMED name (bare-number guess extracted from free-text NOTA) is
 *      only trusted after cross-validating the customer phone against the SAME
 *      candidate order — this also disambiguates the case where two orders
 *      share a phone number (see step 2) by picking the one whose order number
 *      the report actually mentioned.
 *   2) by phone — only when exactly one order carries that phone.
 * Ambiguous (multiple) or zero matches → review (no order linked).
 *
 * Todo eso se juega ANTES sobre los candidatos que el código impreso no
 * descarta (paso 0): un código que nombra un pedido no admite otro.
 */
export function matchShipment(row: MatchableRow, allCandidates: OrderCandidate[]): MatchResult {
  // 0) Si el código impreso nombra un pedido, ese pedido es el único al que
  //    esta guía puede pertenecer, y los demás dejan de ser candidatos.
  //
  //    NO es un atajo para emparejar antes: es una VETO. Lo que evita es que,
  //    cuando el pedido nombrado no está entre los candidatos, el teléfono
  //    enlace la guía a otro pedido del mismo cliente. Ahí el paso 2 encuentra
  //    "exactamente uno" y lo lee como «solo hay uno», cuando significa «solo
  //    he ingerido uno»: el pedido bueno puede no haber llegado aún desde
  //    Shopify. Filtrando aquí, ese caso se queda sin candidatos y cae a
  //    revisión, que es la respuesta honesta.
  //
  //    Pasó 17 veces entre el 01-07 y el 23-07 de 2026, todas con el mismo
  //    perfil: la guía se importó antes que su pedido, el teléfono señalaba a
  //    un pedido anterior del mismo cliente, y los 17 dueños reales entraron al
  //    Master en la carga del 26-07. Nadie volvió a mirar aquellos enlaces.
  const ref = orderRefInGuideCode(row.guide_code);
  const candidates = ref
    ? allCandidates.filter((c) => orderDigits(c.name) === ref)
    : allCandidates;

  // 1) order name
  const wantName = normalizeOrderName(row.order_name);
  if (wantName) {
    const byName = candidates.filter((c) => normalizeOrderName(c.name) === wantName);
    if (row.order_name_confirmed) {
      if (byName.length === 1) {
        const o = byName[0]!;
        return { order_id: o.id, store_id: o.store_id, matched: true, method: "order_name", status: "matched" };
      }
      if (byName.length > 1) {
        // ambiguous confirmed name (rare) — try to disambiguate by phone before
        // giving up, rather than sending a resolvable case straight to review
        if (row.customer_phone) {
          const disambiguated = byName.filter((c) => c.customer_phone === row.customer_phone);
          if (disambiguated.length === 1) {
            const o = disambiguated[0]!;
            return {
              order_id: o.id,
              store_id: o.store_id,
              matched: true,
              method: "order_name_phone",
              status: "matched",
            };
          }
        }
        return { order_id: null, store_id: null, matched: false, method: "none", status: "review" };
      }
    } else if (row.customer_phone) {
      // unconfirmed bare-number candidate: only trust it cross-validated by phone
      const crossValidated = byName.filter((c) => c.customer_phone === row.customer_phone);
      if (crossValidated.length === 1) {
        const o = crossValidated[0]!;
        return {
          order_id: o.id,
          store_id: o.store_id,
          matched: true,
          method: "order_name_phone",
          status: "matched",
        };
      }
      // no cross-validated match → fall through to phone-only matching below
    }
  }

  // 2) phone (single unambiguous match only)
  if (row.customer_phone) {
    const byPhone = candidates.filter((c) => c.customer_phone && c.customer_phone === row.customer_phone);
    if (byPhone.length === 1) {
      const o = byPhone[0]!;
      return { order_id: o.id, store_id: o.store_id, matched: true, method: "phone", status: "matched" };
    }
  }

  return { order_id: null, store_id: null, matched: false, method: "none", status: "review" };
}
