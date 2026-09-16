// Liquidaciones 2 — vocabulario de estados por dominio y su equivalente en
// Kapta. Puro y testeado (test/sheets-statuses.test.ts).
//
// LA REGLA (MOM §30.3). Cada dominio tiene una lista cerrada de estados. Cada
// estado dice a qué estado OPERATIVO de Kapta equivale y qué efecto tiene
// sobre el pedido. Lo que llega de una hoja o de un archivo se normaliza y se
// busca entre los alias de la hoja; si no está, NO se adivina: se guarda como
// alias sin equivalente y la fila queda a revisión. Es la misma disciplina que
// ya aplica Tanders (MOM §9.4): un estado que no reconocemos se guarda literal
// y no toca la guía.
//
// Lo que hay aquí es la SEMILLA: lo que la operación escribía en el Excel
// (cruce del 16-09-2026) y lo que ya traducen los adaptadores de Aliclik,
// Shalom y Tanders. Desde la pantalla se puede corregir cualquier equivalencia
// y añadir alias; la base manda sobre este archivo una vez sembrada.

import { OPERATIONAL_STATUSES } from "@/lib/order-status";
import type { ContributionMark, StatusEffect } from "./types";

export interface StatusTemplate {
  code: string;
  label: string;
  operational_status: string;
  effect: StatusEffect;
  /** Alias que se siembran en cada hoja nueva del dominio (ya normalizados). */
  aliases: readonly string[];
}

const OPERATIONAL_CODES: ReadonlySet<string> = new Set(OPERATIONAL_STATUSES.map((s) => s.code));

/** ¿Es un estado operativo que Kapta conoce? Toda equivalencia debe serlo. */
export function isOperationalCode(code: string): boolean {
  return OPERATIONAL_CODES.has(code);
}

/**
 * Normaliza lo que escribe la gente para compararlo: mayúsculas, sin acentos,
 * sin puntuación al final y con un solo espacio entre palabras. «Reprogramado»,
 * «REPROGRAMADO.» y « reprogramado » son el mismo alias.
 */
export function normalizeAlias(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!¡?¿]+$/g, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Reparto propio — lo que escriben los motorizados (Roy, Yhoni, Duglas…)
// ---------------------------------------------------------------------------
export const REPARTO_PROPIO_STATUSES: readonly StatusTemplate[] = [
  { code: "entregado", label: "Entregado", operational_status: "entregado", effect: "entrega",
    aliases: ["ENTREGADO", "ENTREGADA", "ENTREGADO EFECTIVO", "ENTREGADO YAPE", "ENTREGADO PLIN", "ENTREGADO POS", "OK"] },
  { code: "en_ruta", label: "En ruta", operational_status: "en_reparto", effect: "informa",
    aliases: ["EN RUTA", "EN REPARTO", "SALIO"] },
  { code: "no_responde", label: "No responde", operational_status: "intento_de_entrega", effect: "informa",
    aliases: ["NO RESPONDE", "NO CONTESTA", "NO RESPONDIO", "NO CONTESTO", "APAGADO"] },
  { code: "no_recibe", label: "No recibe", operational_status: "intento_de_entrega", effect: "informa",
    aliases: ["NO RECIBE", "NO RECIBIO", "NADIE EN CASA", "AUSENTE"] },
  { code: "no_confirmo", label: "No confirmó", operational_status: "espera_respuesta_cliente", effect: "informa",
    aliases: ["NO CONFIRMO", "NO CONFRIMO", "SIN CONFIRMAR", "NO CONFIRMA"] },
  { code: "reprogramado", label: "Reprogramado", operational_status: "reprogramado", effect: "informa",
    aliases: ["REPROGRAMADO", "REPRO", "REPROGRAMAR", "REPROGRAMA", "MAÑANA", "MANANA", "OTRO DIA", "PARA MAÑANA"] },
  { code: "retirado", label: "Retirado de la ruta", operational_status: "pendiente_nuevo_courier", effect: "informa",
    aliases: ["RETIRADO", "RETIRADA", "SE RETIRO", "VUELVE A OFICINA"] },
  { code: "rechazado", label: "Rechazado por el cliente", operational_status: "en_seguimiento", effect: "anulacion",
    aliases: ["RECHAZADO", "RECHAZA", "NO QUIERE", "NO LO QUIERE", "CAIDA", "CAIDO", "CAYO"] },
  { code: "cancelado", label: "Cancelado por el cliente", operational_status: "en_seguimiento", effect: "anulacion",
    aliases: ["CANCELADO", "CANCELO", "CANCELA", "ANULADO", "ANULO"] },
  { code: "devuelto", label: "Devuelto a oficina", operational_status: "devuelto_al_origen", effect: "devolucion",
    aliases: ["DEVUELTO", "DEVOLUCION", "DEVUELTA", "RETORNADO"] },
];

// ---------------------------------------------------------------------------
// Courier externo — lo que reportan Aliclik, Swayp/Fenix, Shalom, Olva, Axel…
// ---------------------------------------------------------------------------
export const COURIER_EXTERNO_STATUSES: readonly StatusTemplate[] = [
  { code: "entregado", label: "Entregado", operational_status: "entregado", effect: "entrega",
    aliases: ["ENTREGADO", "ENTREGADA", "DELIVERED", "ENTREGADO AL CLIENTE"] },
  { code: "recogido", label: "Recogido en agencia", operational_status: "recogido", effect: "entrega",
    aliases: ["RECOGIDO", "RETIRADO EN AGENCIA", "RECOGIDO POR EL CLIENTE", "CONFORME"] },
  { code: "pendiente", label: "Pendiente / asignado", operational_status: "asignado_a_courier", effect: "informa",
    aliases: ["PENDIENTE", "ASIGNADO", "REGISTRADO", "GENERADO", "CREADO"] },
  { code: "despachado", label: "Despachado", operational_status: "despachado", effect: "informa",
    aliases: ["DESPACHADO", "SE ENVIO", "SE EMVIO", "ENVIADO", "RECOLECTADO", "RECOGIDO POR COURIER"] },
  { code: "en_transito", label: "En tránsito", operational_status: "en_transito", effect: "informa",
    aliases: ["EN TRANSITO", "TRANSITO", "IN TRANSIT", "EN VIAJE", "EN CAMINO"] },
  { code: "en_reparto", label: "En reparto", operational_status: "en_reparto", effect: "informa",
    aliases: ["EN REPARTO", "EN RUTA", "OUT FOR DELIVERY", "MOTORIZADO EN CAMINO"] },
  { code: "en_agencia", label: "En agencia / disponible para recojo", operational_status: "disponible_para_recojo", effect: "informa",
    aliases: ["EN AGENCIA", "DISPONIBLE PARA RECOJO", "LLEGO A AGENCIA", "EN DESTINO", "PARA RECOJO"] },
  { code: "no_contesta", label: "No contesta / intento fallido", operational_status: "intento_de_entrega", effect: "informa",
    aliases: ["NO CONTESTA", "NO RESPONDE", "NO CONTESTA PARA COORDINAR", "INTENTO FALLIDO", "AUSENTE", "DIRECCION INCORRECTA", "DIRECCION ERRADA"] },
  { code: "reprogramado", label: "Reprogramado", operational_status: "reprogramado", effect: "informa",
    aliases: ["REPROGRAMADO", "REPRO", "REPROGRAMACION", "REAGENDADO", "NUEVA FECHA"] },
  { code: "cancelado", label: "Cancelado por el courier", operational_status: "en_seguimiento", effect: "anulacion",
    aliases: ["CANCELADO", "ANULADO", "CANCELADA", "ANULADA", "CANCELADO CLIENTE INDICA", "RECHAZADO", "RECHAZO"] },
  { code: "dejado_en_almacen", label: "Dejado en almacén (retorno)", operational_status: "en_proceso_de_retorno", effect: "devolucion",
    aliases: ["DEJADO EN ALMACEN", "EN ALMACEN", "RETORNO INICIADO", "EN RETORNO", "DEVOLUCION EN CURSO"] },
  { code: "devuelto", label: "Devuelto al origen", operational_status: "devuelto_al_origen", effect: "devolucion",
    aliases: ["DEVUELTO", "DEVUELTA", "RETORNADO", "DEVUELTO AL ORIGEN", "DEVOLUCION REALIZADA", "DEVOLUCION CONFIRMADA"] },
];

// ---------------------------------------------------------------------------
// Consolidado — lo que resuelve la columna Estatus (MOM §30.4). Se registra
// como vocabulario para que KPI y exportaciones lo lean del mismo sitio.
// ---------------------------------------------------------------------------
export const CONSOLIDADO_STATUSES: readonly StatusTemplate[] = [
  { code: "entregado", label: "Entregado", operational_status: "entregado", effect: "entrega", aliases: ["ENTREGADO"] },
  { code: "devuelto", label: "Devuelto", operational_status: "devuelto_al_origen", effect: "devolucion", aliases: ["DEVUELTO"] },
  { code: "anulado", label: "Anulado", operational_status: "anulado", effect: "anulacion", aliases: ["ANULADO"] },
  { code: "transito", label: "Tránsito", operational_status: "en_reparto", effect: "informa", aliases: ["TRANSITO", "EN TRANSITO"] },
  { code: "pendiente", label: "Pendiente", operational_status: "sin_confirmar", effect: "informa", aliases: ["PENDIENTE"] },
];

/** Marca que aporta un estado al Consolidado, por su efecto. */
export function markForEffect(effect: StatusEffect): ContributionMark {
  switch (effect) {
    case "entrega":
      return "E";
    case "devolucion":
      return "D";
    case "informa":
      return "T";
    case "anulacion":
      // Un cancelado del courier no cierra nada: el pedido sigue vivo hasta
      // que Shopify lo anule. Para el Consolidado cuenta como intento.
      return "T";
  }
}

export interface StatusLookup {
  /** Alias normalizado → código de estado del dominio (null = visto, sin equivalente). */
  aliases: ReadonlyMap<string, string | null>;
  /** Códigos válidos del dominio. */
  codes: ReadonlySet<string>;
}

export type StatusResolution =
  | { kind: "ok"; code: string; alias: string }
  | { kind: "unknown"; alias: string }
  | { kind: "empty" };

/**
 * Traduce lo que trae una fila al estado del dominio. Primero el código tal
 * cual (una lista cerrada en la pantalla), luego el alias normalizado. Sin
 * coincidencia devuelve `unknown` con el alias para que la hoja lo registre y
 * alguien le asigne equivalente; nunca escoge uno «parecido».
 */
export function resolveStatus(raw: string | null | undefined, lookup: StatusLookup): StatusResolution {
  const alias = normalizeAlias(raw);
  if (!alias) return { kind: "empty" };
  const asCode = alias.toLowerCase().replace(/\s+/g, "_");
  if (lookup.codes.has(asCode)) return { kind: "ok", code: asCode, alias };
  const mapped = lookup.aliases.get(alias);
  if (mapped) return { kind: "ok", code: mapped, alias };
  return { kind: "unknown", alias };
}

/** Construye el lookup a partir de plantillas: útil en pruebas y al sembrar. */
export function lookupFromTemplates(statuses: readonly StatusTemplate[]): StatusLookup {
  const aliases = new Map<string, string | null>();
  for (const status of statuses) {
    for (const alias of status.aliases) aliases.set(normalizeAlias(alias), status.code);
  }
  return { aliases, codes: new Set(statuses.map((s) => s.code)) };
}

/**
 * SUGERENCIA para un alias desconocido, a partir de familias de palabras.
 * Solo rellena el desplegable en la configuración: nunca se aplica sola. El
 * orden importa igual que en classifyAgencyStatus: «entregado» gana sobre
 * todo, y «devuelto» solo cuando el texto lo dice explícitamente.
 */
export function suggestStatus(raw: string, domain: "reparto_propio" | "courier_externo"): string | null {
  const text = normalizeAlias(raw);
  if (!text) return null;
  if (/DEVUELT|RETORNAD|DEVOLUCION REALIZADA|DEVOLUCION CONFIRMADA/.test(text)) return "devuelto";
  if (/ALMACEN|EN RETORNO|RETORNO INICIADO/.test(text) && domain === "courier_externo") return "dejado_en_almacen";
  if (/ENTREGAD|RECOGID|CONFORME|DELIVERED/.test(text)) return domain === "courier_externo" && /RECOGID|CONFORME/.test(text) ? "recogido" : "entregado";
  if (/CANCEL|ANULAD|RECHAZ|CAID|CAYO/.test(text)) return domain === "reparto_propio" && /RECHAZ|CAID|CAYO/.test(text) ? "rechazado" : "cancelado";
  if (/REPRO|REAGEND|MAÑANA|MANANA|OTRO DIA|NUEVA FECHA/.test(text)) return "reprogramado";
  if (/NO CONTESTA|NO RESPONDE|APAGADO|AUSENTE|DIRECCION/.test(text)) return domain === "reparto_propio" ? "no_responde" : "no_contesta";
  if (/NO RECIBE|NADIE/.test(text)) return domain === "reparto_propio" ? "no_recibe" : "no_contesta";
  if (/NO CONFIRM|NO CONFRIM|SIN CONFIRMAR/.test(text)) return domain === "reparto_propio" ? "no_confirmo" : null;
  if (/RETIRAD/.test(text)) return domain === "reparto_propio" ? "retirado" : "recogido";
  if (/TRANSITO|TRANSIT|EN CAMINO|EN VIAJE/.test(text)) return domain === "courier_externo" ? "en_transito" : "en_ruta";
  if (/REPARTO|EN RUTA|OUT FOR/.test(text)) return domain === "courier_externo" ? "en_reparto" : "en_ruta";
  if (/AGENCIA|PARA RECOJO|EN DESTINO/.test(text)) return domain === "courier_externo" ? "en_agencia" : null;
  if (/DESPACH|ENVIO|ENVIADO|EMVIO|RECOLECT/.test(text)) return domain === "courier_externo" ? "despachado" : "en_ruta";
  if (/PENDIENTE|ASIGNAD|REGISTRAD|GENERAD|CREAD/.test(text)) return domain === "courier_externo" ? "pendiente" : null;
  return null;
}
