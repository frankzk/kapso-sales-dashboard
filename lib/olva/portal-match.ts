// «Cotejar Olva»: qué salida de Kapta es cada envío del portal de Olva (MOM
// §12). PURO Y TESTEADO: ni red ni base.
//
// SOLO SE VINCULA LO QUE NO ADMITE DUDA. Pegar el tracking equivocado no es un
// error cosmético: Kapta rastrea ese envío, cambia el estado de OTRO pedido y
// le manda a OTRA clienta el aviso de «tu pedido va en camino». Por eso hay
// dos caminos y ninguno adivina:
//
//   1. «Doc. externo» igual al número del pedido (o al código de la salida).
//      Es lo que quien registra en Olva puede teclear, y entonces no hay nada
//      que interpretar.
//   2. La MISMA dirección —Olva la guarda tal cual se le dio, más « NRO null»
//      y la referencia entre paréntesis— y TODOS los nombres que Kapta tiene
//      de la clienta dentro del destinatario de Olva, que suele llevar además
//      el segundo nombre. Con al menos dos nombres: «Carlos Carlos» no basta.
//
//   3. El DNI. El listado del portal no lo trae, pero el portal SÍ filtra por
//      el documento del destinatario (`dni_consignado`). Se le pregunta por el
//      DNI que la clienta dio para el envío (`shalom_order_drafts`) y vale si
//      contesta UN solo envío sin tracking, del rango de fechas, con al menos
//      un nombre en común. Lo del nombre no es por desconfiar del DNI: es por
//      si el portal un día ignora el filtro y devuelve cualquier cosa.
//
// Y en todos, una pareja única: un envío con una sola salida posible y esa
// salida pedida por un solo envío. Todo lo demás va a «revisar», con los
// candidatos a la vista, y lo decide una persona.
//
// Caso real (02-10-2026): «Ciro Alegria Claro» en Kapta y «CIRO ALEGRIA
// ALVARON» en Olva, misma dirección. Casi seguro es él, pero «Claro» no está
// en Olva: va a revisar. Igual «Ramiro Casapia Guzman» contra «JORGE CASAPIA
// GUZMAN»: misma casa, otra persona recibiendo.

import { formatOlvaTracking } from "@/lib/olva/tracking";
import type { OlvaPortalRow } from "@/lib/olva/portal";

/** Una salida de Olva de Kapta sin tracking: lo que se puede vincular. */
export interface CotejoCandidate {
  shipmentId: string;
  storeId: string;
  orderName: string | null;
  guideCode: string | null;
  customerName: string | null;
  address: string | null;
  district: string | null;
  /** ISO: cuándo se creó la salida en Kapta. */
  createdAt: string;
  /** El DNI (o CE) que la clienta dio para el envío, si se apuntó. */
  dni?: string | null;
}

export type CotejoVia = "doc_externo" | "nombre_direccion" | "dni";

export interface CotejoHint {
  candidate: CotejoCandidate;
  why: string;
}

export type CotejoOutcome =
  | { kind: "ya_vinculado"; row: OlvaPortalRow; orderName: string | null }
  | { kind: "vincular"; row: OlvaPortalRow; candidate: CotejoCandidate; via: CotejoVia }
  | { kind: "revisar"; row: OlvaPortalRow; reason: string; hints: CotejoHint[] }
  | { kind: "sin_pareja"; row: OlvaPortalRow };

/** Una salida se crea antes de que el paquete llegue al mostrador de Olva. */
const WINDOW_BEFORE_DAYS = 21;
const WINDOW_AFTER_DAYS = 2;
const MAX_HINTS = 3;
/** Una dirección más corta que esto («Lima», «s/n») no identifica a nadie. */
const MIN_ADDRESS_CHARS = 8;

export function normalizeText(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * La dirección como la dio Kapta. Olva le añade « NRO <número>» (vacío:
 * «null») y la referencia entre paréntesis; se quitan solo esas dos cosas.
 * Un « NRO 118» de verdad se queda: es parte de la dirección.
 */
export function olvaAddressCore(direccion: string): string {
  let s = direccion.trim();
  for (let i = 0; i < 3 && /\)\s*$/.test(s); i += 1) s = s.replace(/\s*\([^()]*\)\s*$/, "");
  s = s.replace(/\s+NRO\s+null\s*$/i, "");
  return normalizeText(s);
}

export function nameTokens(name: string | null | undefined): Set<string> {
  return new Set(normalizeText(name).split(" ").filter((t) => t.length >= 2));
}

/** ¿Están TODOS los nombres de Kapta en el destinatario de Olva? Con dos o más. */
export function nameCovered(kapta: string | null, olva: string): boolean {
  const k = nameTokens(kapta);
  if (k.size < 2) return false;
  const o = nameTokens(olva);
  for (const t of k) if (!o.has(t)) return false;
  return true;
}

function sharedNames(kapta: string | null, olva: string): number {
  const o = nameTokens(olva);
  let n = 0;
  for (const t of nameTokens(kapta)) if (o.has(t)) n += 1;
  return n;
}

function sameAddress(c: CotejoCandidate, row: OlvaPortalRow): boolean {
  const k = normalizeText(c.address);
  return k.length >= MIN_ADDRESS_CHARS && k === olvaAddressCore(row.direccion);
}

function docKey(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[#\s]/g, "");
}

function limaDay(iso: string): string {
  return new Date(new Date(iso).getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

function inWindow(c: CotejoCandidate, row: OlvaPortalRow): boolean {
  if (!row.fechaRegistro) return true;
  const d = limaDay(c.createdAt);
  return d >= addDays(row.fechaRegistro, -WINDOW_BEFORE_DAYS) && d <= addDays(row.fechaRegistro, WINDOW_AFTER_DAYS);
}

function exactMatches(row: OlvaPortalRow, candidates: CotejoCandidate[]): { via: CotejoVia; list: CotejoCandidate[] } {
  const doc = docKey(row.docExterno);
  if (doc.length >= 4) {
    const byDoc = candidates.filter((c) => docKey(c.orderName) === doc || docKey(c.guideCode) === doc);
    // Un «Doc. externo» que no es de ninguna salida libre no impide el otro
    // camino: puede ser una nota cualquiera.
    if (byDoc.length) return { via: "doc_externo", list: byDoc };
  }
  return {
    via: "nombre_direccion",
    list: candidates.filter((c) => inWindow(c, row) && sameAddress(c, row) && nameCovered(c.customerName, row.destinatario)),
  };
}

function hintsFor(row: OlvaPortalRow, candidates: CotejoCandidate[]): CotejoHint[] {
  const scored: { c: CotejoCandidate; score: number; why: string }[] = [];
  for (const c of candidates) {
    if (!inWindow(c, row)) continue;
    const addr = sameAddress(c, row);
    const covered = nameCovered(c.customerName, row.destinatario);
    const shared = sharedNames(c.customerName, row.destinatario);
    if (addr && covered) scored.push({ c, score: 4, why: "misma dirección y mismos nombres" });
    else if (addr) scored.push({ c, score: 3, why: `misma dirección; en Kapta figura «${c.customerName ?? "sin nombre"}»` });
    else if (covered) scored.push({ c, score: 2, why: "mismos nombres; la dirección es otra" });
    else if (shared >= 2) scored.push({ c, score: 1, why: `comparte ${shared} nombres; la dirección es otra` });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HINTS)
    .map((s) => ({ candidate: s.c, why: s.why }));
}

/**
 * Coteja los envíos del portal contra las salidas sin tracking.
 *
 * @param linked  trackings ya puestos en alguna salida («2649804-26» → pedido).
 */
export function matchPortalRows(
  rows: OlvaPortalRow[],
  candidates: CotejoCandidate[],
  linked: Map<string, string | null>,
): CotejoOutcome[] {
  const pending = rows.filter((r) => !linked.has(formatOlvaTracking(r.id)));
  const exact = new Map<OlvaPortalRow, { via: CotejoVia; list: CotejoCandidate[] }>();
  const claims = new Map<string, number>();
  for (const row of pending) {
    const m = exactMatches(row, candidates);
    exact.set(row, m);
    for (const c of m.list) claims.set(c.shipmentId, (claims.get(c.shipmentId) ?? 0) + 1);
  }

  return rows.map((row): CotejoOutcome => {
    const key = formatOlvaTracking(row.id);
    if (linked.has(key)) return { kind: "ya_vinculado", row, orderName: linked.get(key) ?? null };

    const m = exact.get(row)!;
    const why = m.via === "doc_externo" ? "el Doc. externo es este pedido" : "misma dirección y mismos nombres";
    const only = m.list[0];
    if (m.list.length === 1 && only) {
      if ((claims.get(only.shipmentId) ?? 0) === 1) {
        return { kind: "vincular", row, candidate: only, via: m.via };
      }
      return {
        kind: "revisar",
        row,
        reason: `Otro envío de Olva apunta a la misma salida (${only.orderName ?? "sin pedido"}).`,
        hints: [{ candidate: only, why }],
      };
    }
    if (m.list.length > 1) {
      return {
        kind: "revisar",
        row,
        reason: `${m.list.length} salidas coinciden igual de bien.`,
        hints: m.list.slice(0, MAX_HINTS).map((c) => ({ candidate: c, why })),
      };
    }
    const hints = hintsFor(row, candidates);
    if (hints.length) return { kind: "revisar", row, reason: "Se parece, pero no es idéntico.", hints };
    return { kind: "sin_pareja", row };
  });
}

/**
 * Lo que el portal contestó al preguntarle por el DNI de una salida: el envío
 * que le corresponde, o null si no hay uno solo que no admita duda.
 */
export function dniMatch(
  candidate: CotejoCandidate,
  rowsForDni: OlvaPortalRow[],
  linked: Map<string, string | null>,
): OlvaPortalRow | null {
  const free = rowsForDni.filter((r) => !linked.has(formatOlvaTracking(r.id)));
  const [only] = free;
  if (free.length !== 1 || !only) return null;
  if (!inWindow(candidate, only)) return null;
  return sharedNames(candidate.customerName, only.destinatario) >= 1 ? only : null;
}

function hintOf(candidate: CotejoCandidate, why: string): CotejoHint {
  return { candidate, why };
}

/**
 * Suma al cotejo lo que se encontró por DNI. Una pareja por DNI solo se
 * vincula si nadie más la discute: ni otra salida con el mismo envío, ni otro
 * envío ya emparejado con esa salida por otro camino.
 */
export function mergeDniMatches(
  outcomes: CotejoOutcome[],
  pairs: { candidate: CotejoCandidate; row: OlvaPortalRow }[],
): CotejoOutcome[] {
  const out = [...outcomes];
  const key = (row: OlvaPortalRow) => formatOlvaTracking(row.id);
  const indexOf = (row: OlvaPortalRow) => out.findIndex((o) => key(o.row) === key(row));
  const byTracking = new Map<string, { row: OlvaPortalRow; candidates: CotejoCandidate[] }>();
  for (const p of pairs) {
    const entry = byTracking.get(key(p.row)) ?? { row: p.row, candidates: [] };
    if (!entry.candidates.some((c) => c.shipmentId === p.candidate.shipmentId)) entry.candidates.push(p.candidate);
    byTracking.set(key(p.row), entry);
  }

  const put = (row: OlvaPortalRow, next: CotejoOutcome) => {
    const i = indexOf(row);
    if (i >= 0) out[i] = next;
    else out.push(next);
  };

  for (const { row, candidates } of byTracking.values()) {
    const i = indexOf(row);
    const current = i >= 0 ? out[i] : undefined;
    if (current?.kind === "ya_vinculado") continue;
    const [only] = candidates;
    if (candidates.length !== 1 || !only) {
      put(row, {
        kind: "revisar",
        row,
        reason: `El mismo envío responde al DNI de ${candidates.length} salidas.`,
        hints: candidates.slice(0, MAX_HINTS).map((c) => hintOf(c, "mismo DNI")),
      });
      continue;
    }
    if (current?.kind === "vincular") {
      if (current.candidate.shipmentId === only.shipmentId) continue;
      put(row, {
        kind: "revisar",
        row,
        reason: "El DNI apunta a una salida y la dirección y el nombre a otra.",
        hints: [hintOf(current.candidate, "misma dirección y mismos nombres"), hintOf(only, "mismo DNI")],
      });
      continue;
    }
    // ¿Esa salida ya se la llevó OTRO envío por otro camino?
    const rival = out.findIndex(
      (o) => o.kind === "vincular" && o.candidate.shipmentId === only.shipmentId && key(o.row) !== key(row),
    );
    if (rival >= 0) {
      const other = out[rival]!;
      out[rival] = {
        kind: "revisar",
        row: other.row,
        reason: "Otro envío de Olva responde al DNI de esta salida.",
        hints: [hintOf(only, "misma dirección y mismos nombres")],
      };
      put(row, { kind: "revisar", row, reason: "Otro envío de Olva coincide con esta salida.", hints: [hintOf(only, "mismo DNI")] });
      continue;
    }
    put(row, { kind: "vincular", row, candidate: only, via: "dni" });
  }
  return out;
}
