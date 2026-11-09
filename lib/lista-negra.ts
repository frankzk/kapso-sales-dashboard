// La «Lista negra» en una sola página (MOM §41 y §41.11, owner 09-11-2026):
// lo que junta las dos listas que frenan el contra entrega. Puro: sin base ni
// red. Lo que se DICE de ella está en lib/lista-negra-copy.ts.
//
//   * La AUTOMÁTICA (internamente «pago solo online», lib/pago-online.ts): la
//     calcula Kapta cada día, se manda a las tiendas y pide el adelanto de
//     S/ 20 (o lo que diga el ajuste). Sus celulares los lee solo el servidor.
//   * La AGREGADA A MANO (`prepay_list_entries`, lib/prepay-list.ts): para lo
//     que la regla no ve (un fraude, una clienta que avisó que no va a
//     recibir). Cada alta elige «Adelanto de S/ 20» o «Pago total».
//
// LO QUE VA A LAS TIENDAS es la UNIÓN de las dos, sin repetidos: el envío
// diario de la automática lleva también las altas vivas a mano. Las
// excepciones de Kapta sacan a alguien SOLO de la automática: un alta a mano
// es una decisión de una persona y va igual.
//
// NADA de aquí devuelve la lista: la búsqueda contesta por UN celular, y las
// marcas de Leads y del Master dicen sí o no (con su motivo) de los celulares
// que la página ya muestra.

import { lnBadgeLabel, lnBadgeTitle, lnMotivo, LN_REQUIREMENT_LABEL, type LnRequirement } from "@/lib/lista-negra-copy";
import {
  pagoOnlineListedKey,
  pagoOnlineMaskedPhone,
  pagoOnlineMotivo,
  pagoOnlinePhoneKey,
  type PagoOnlineMode,
  type PagoOnlineReason,
  type PagoOnlineRequirement,
} from "@/lib/pago-online";
import { prepayEntryRequirementOf, prepayPhoneLabel, type PrepayEntryRequirement } from "@/lib/prepay-list";

// ── Lo que se manda a las tiendas ───────────────────────────────────────────

/**
 * La lista que se manda a cada tienda: los celulares de la corrida vigente de
 * la automática (ya sin las excepciones de Kapta) MÁS los de las altas vivas a
 * mano, en 9 dígitos, sin repetidos y ordenados. `manualOnly`: cuántos van
 * solo por un alta a mano (para la `regla` y el registro). Pura.
 */
export function listaNegraSendPhones(
  autoPhones: readonly (string | null | undefined)[],
  manualPhones: readonly (string | null | undefined)[],
): { phones: string[]; manualOnly: number } {
  const all = new Set(autoPhones.map(pagoOnlinePhoneKey).filter((p): p is string => !!p));
  let manualOnly = 0;
  for (const raw of manualPhones) {
    const p = pagoOnlinePhoneKey(raw);
    if (!p || all.has(p)) continue;
    all.add(p);
    manualOnly++;
  }
  return { phones: [...all].sort(), manualOnly };
}

/** La `regla` que lee la tienda (texto libre de su panel), con las altas a mano si hay. Pura. */
export function listaNegraRegla(regla: string, manualOnly: number): string {
  if (!manualOnly) return regla;
  return `${regla} · más ${manualOnly.toLocaleString("es-PE")} ${manualOnly === 1 ? "agregado" : "agregados"} a mano en Kapta`;
}

// ── La marca de una fila (Master y Leads) ───────────────────────────────────

/** Lo que una fila sabe de la lista: por qué está y qué se le pide. Sin celulares. */
export interface ListaNegraMark {
  source: "manual" | "auto";
  motivo: string;
  requirement: LnRequirement;
}

/** La llave de un celular en la lista: organización + 9 dígitos (la misma de la chapa del Master). Pura. */
export function listaNegraKey(orgId: string, rawPhone: string | null | undefined): string | null {
  const p = pagoOnlinePhoneKey(rawPhone);
  return p && orgId ? pagoOnlineListedKey(orgId, p) : null;
}

/** La marca de un alta viva a mano. Pura. */
export function listaNegraManualMark(entry: { reason: string | null; requirement?: unknown }): ListaNegraMark {
  return { source: "manual", motivo: lnMotivo({ kind: "manual", reason: entry.reason }), requirement: prepayEntryRequirementOf(entry.requirement) };
}

/** La marca de un celular de la automática vigente, con el cobro de la organización. Pura. */
export function listaNegraAutoMark(row: { reason: PagoOnlineReason; failed: number | null; orders: number | null }, requirement: PagoOnlineRequirement): ListaNegraMark {
  return { source: "auto", motivo: pagoOnlineMotivo(row), requirement };
}

/**
 * Junta las dos: con las dos, gana la que pide más (el pago total); si piden
 * lo mismo, el alta a mano (la decidió una persona). Pura.
 */
export function listaNegraMergeMarks(manual: ListaNegraMark | null | undefined, auto: ListaNegraMark | null | undefined): ListaNegraMark | null {
  if (!manual) return auto ?? null;
  if (!auto) return manual;
  return auto.requirement === "pago_completo" && manual.requirement !== "pago_completo" ? auto : manual;
}

/** La chapa de una marca: «Lista negra» (o «· pago total») y su tooltip «{motivo}. {requisito}». Pura. */
export function listaNegraBadge(mark: ListaNegraMark): { label: string; title: string } {
  return { label: lnBadgeLabel(mark.requirement), title: lnBadgeTitle(mark.motivo, mark.requirement) };
}

/**
 * Marca las filas de una página con `lista_negra`, desde UNA lectura del
 * servidor (llaves `listaNegraKey` → marca, de las dos listas). Cada fila con
 * la organización de SU tienda. Sin lectura (`null`), no afirma nada. Pura.
 */
export function withListaNegra<T extends { store_id?: string | null }>(
  rows: T[],
  marks: ReadonlyMap<string, ListaNegraMark> | null,
  storeOrg: ReadonlyMap<string, string>,
  phoneOf: (row: T) => string | null | undefined,
): (T & { lista_negra?: ListaNegraMark | null })[] {
  if (!marks) return rows;
  return rows.map((r) => {
    const org = r.store_id ? storeOrg.get(r.store_id) : undefined;
    const key = org ? listaNegraKey(org, phoneOf(r)) : null;
    return { ...r, lista_negra: (key && marks.get(key)) || null };
  });
}

// ── La búsqueda por UN celular ──────────────────────────────────────────────

/** Lo que el servidor leyó para un celular, tal cual (sin ningún otro celular). */
export interface ListaNegraSearchInput {
  phone: string;
  /** La posición y el cobro de la automática de la organización. */
  mode: PagoOnlineMode;
  requirement: PagoOnlineRequirement;
  hasCurrentList: boolean;
  /** Su fila en la corrida vigente, o null si no está. */
  autoRow: { reason: PagoOnlineReason; failed: number | null; orders: number | null } | null;
  /** Su excepción de Kapta viva, si tiene. */
  exception: { id: string; reason: string; added_at: string; order_name: string | null; added_by_name: string } | null;
  /** Su alta viva a mano, si tiene. */
  manual: { id: string; reason: string; requirement?: unknown; added_at: string; added_by_name: string; source: string } | null;
  /** Sus pedidos más recientes que quien busca puede ver. */
  orders: { order_id: string; order_name: string | null; general_status: string | null; order_created_at: string | null }[];
  canManage: boolean;
  /** Para mostrar las fechas. */
  formatAt: (iso: string) => string;
}

export interface ListaNegraSearchView {
  /** El celular buscado, como lo escribió quien busca («987 654 321»). */
  phoneLabel: string;
  /** ¿Kapta frena hoy su contra entrega? (automática viva y sin excepción, o alta a mano). */
  listed: boolean;
  /** La marca que manda hoy (motivo y requisito), si está. */
  mark: ListaNegraMark | null;
  requirementLabel: string | null;
  automatic: {
    /** Frena hoy: Activo, en la vigente y sin excepción. */
    braking: boolean;
    motivo: string;
  } | null;
  /** Por qué no hay automática que mirar («Apagada», «en Simulación», sin lista vigente). */
  automaticNote: string | null;
  exception: { id: string; reason: string; addedAt: string; addedBy: string; orderName: string | null } | null;
  manual: { id: string; motivo: string; requirement: PrepayEntryRequirement; requirementLabel: string; addedAt: string; addedBy: string } | null;
  orders: { id: string; name: string; status: string | null }[];
  /** Quien busca puede exceptuarla de la automática: está en la vigente, no exceptuada y tiene `prepay_list.manage`. */
  canExcept: boolean;
}

/** Cuántos pedidos recientes se muestran. */
export const LISTA_NEGRA_SEARCH_ORDERS = 5;

/**
 * La respuesta de la búsqueda: SOLO lo de este celular. Pura.
 *
 *   * `automatic`: su fila de la corrida vigente, con su motivo; frena solo en
 *     Activo y sin excepción.
 *   * `manual`: su alta viva a mano, con lo que pide.
 *   * `mark`: lo que manda hoy; con las dos, la que pide más.
 *   * `orders`: sus últimos pedidos (nombres), para ir a la ficha.
 */
export function listaNegraSearchView(input: ListaNegraSearchInput): ListaNegraSearchView {
  const inAuto = !!input.autoRow && input.mode === "activo" && input.hasCurrentList;
  const braking = inAuto && !input.exception;
  const autoMark = inAuto && input.autoRow ? listaNegraAutoMark(input.autoRow, input.requirement) : null;
  const manualMark = input.manual ? listaNegraManualMark(input.manual) : null;
  const mark = listaNegraMergeMarks(manualMark, braking ? autoMark : null);
  const automaticNote =
    input.mode === "apagado"
      ? "La lista automática está Apagada: no frena a nadie."
      : input.mode === "simulacion"
        ? "La lista automática está en Simulación: calcula, pero no frena ni se manda."
        : !input.hasCurrentList
          ? "La lista automática todavía no tiene una lista vigente."
          : null;
  return {
    phoneLabel: prepayPhoneLabel(`51${pagoOnlinePhoneKey(input.phone) ?? ""}`),
    listed: !!mark,
    mark,
    requirementLabel: mark ? LN_REQUIREMENT_LABEL[mark.requirement] : null,
    automatic: autoMark ? { braking, motivo: autoMark.motivo } : null,
    automaticNote,
    exception: input.exception
      ? {
          id: input.exception.id,
          reason: input.exception.reason,
          addedAt: input.formatAt(input.exception.added_at),
          addedBy: input.exception.added_by_name,
          orderName: input.exception.order_name,
        }
      : null,
    manual:
      input.manual && manualMark
        ? {
            id: input.manual.id,
            motivo: manualMark.motivo,
            requirement: manualMark.requirement,
            requirementLabel: LN_REQUIREMENT_LABEL[manualMark.requirement],
            addedAt: input.formatAt(input.manual.added_at),
            addedBy: input.manual.added_by_name,
          }
        : null,
    orders: input.orders.slice(0, LISTA_NEGRA_SEARCH_ORDERS).map((o) => ({ id: o.order_id, name: o.order_name ?? "Pedido", status: o.general_status })),
    canExcept: inAuto && !input.exception && input.canManage,
  };
}

/** Lo único que se muestra del celular de una excepción: «••• ••• 321». Pura. */
export function listaNegraMaskedPhone(phone: string | null | undefined): string {
  return pagoOnlineMaskedPhone(pagoOnlinePhoneKey(phone));
}

// ── El tope de búsquedas ────────────────────────────────────────────────────

/** Cuántas búsquedas por persona en la ventana: de sobra para atender, poco para recorrer números. */
export const LISTA_NEGRA_SEARCH_LIMIT = 30;
export const LISTA_NEGRA_SEARCH_WINDOW_MIN = 10;

/** ¿Ya pasó el tope? Pura. */
export function listaNegraSearchLimited(recent: number): boolean {
  return recent >= LISTA_NEGRA_SEARCH_LIMIT;
}
