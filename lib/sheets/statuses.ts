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
    aliases: ["NO RESPONDE", "NO CONTESTA", "NO RESPONDIO", "NO CONTESTO", "NO RESPOND", "APAGADO", "CEL APAGADO", "NO ESTABA", "NO ESTA", "NP ESTABA", "BUZON", "BUZON/NR", "BUZON NR", "NR", "NO RESPONDE /BUZON", "NHO RESPONDE"] },
  { code: "no_recibe", label: "No recibe", operational_status: "intento_de_entrega", effect: "informa",
    aliases: ["NO RECIBE", "NO RECIBIO", "NADIE EN CASA", "AUSENTE"] },
  { code: "no_confirmo", label: "No confirmó", operational_status: "espera_respuesta_cliente", effect: "informa",
    aliases: ["NO CONFIRMO", "NO CONFRIMO", "SIN CONFIRMAR", "NO CONFIRMA"] },
  { code: "en_espera_cliente", label: "En espera del cliente", operational_status: "espera_respuesta_cliente", effect: "informa",
    aliases: ["DE VIAJE", "FUERA DE LIMA", "AVISARA", "AVISA", "LLAMARA", "SIN DINERO", "NO TIENE DINERO", "CUELGA LLAMADA", "RECHAZA LLAMADA", "CORTA LLAMADA", "COORDINAR", "COODINAR", "POR COORDINAR", "DESEA PROVINCIA", "DESEA PROVICNIA", "DESEA CAMBIO", "PROVINCIA"] },
  { code: "dato_errado", label: "Dato errado (celular o dirección)", operational_status: "detenido_sin_informacion", effect: "informa",
    aliases: ["CEL ERRADO", "CELULAR ERRADO", "NUMERO ERRADO", "FALTA DIRECCION", "SIN DIRECCION", "DIRECCION", "UBICACION", "NO RESPONDE /DIRECCION", "NO RESPONDE /SIN SERVICIO", "NR/SIN DIRECCION", "NR/FALTA DIRECCION", "NR/SIN WHATSAPP", "NR/CEL SIN WHATSAPP", "NO ES LA PERSONA", "DIRECCION ERRADA"] },
  { code: "reprogramado", label: "Reprogramado", operational_status: "reprogramado", effect: "informa",
    aliases: ["REPROGRAMADO", "REPRO", "REPROGRAMAR", "REPROGRAMA", "MAÑANA", "MANANA", "OTRO DIA", "PARA MAÑANA", "PROX SEMANA", "PROXIMA SEMANA", "PROX LUNES", "PROX MARTES", "PROX MIERCOLES", "PROX JUEVES", "PROX VIERNES", "PROX SABADO", "VIENRES", "LUMES", "REPRO HOY", "REWPRO", "PROGRAMADO", "POSTERGADO", "MAS TARDE", "FIN DE MES", "SEMANA QUE VIENE", "DESEA 5PM", "DESEA 6PM", "DESEA 4PM", "DESEA 7PM", "EN LA TARDE", "EN LA NOCHE"] },
  { code: "retirado", label: "Retirado de la ruta", operational_status: "pendiente_nuevo_courier", effect: "informa",
    aliases: ["RETIRADO", "RETIRADA", "SE RETIRO", "VUELVE A OFICINA", "PASAR ALEXIS", "PASA A ALEXIS", "CON ALEXIS", "REPRO ALEXIS", "REPRO CON ALEXIS", "MANANA ALEXIS", "MANANA CON ALEXIS", "MANANA/ALEXIS", "ALEXIS", "ROY", "YHONI", "DUGLAS", "FENIX"] },
  { code: "rechazado", label: "Rechazado por el cliente", operational_status: "en_seguimiento", effect: "anulacion",
    aliases: ["RECHAZADO", "RECHAZA", "NO QUIERE", "NO LO QUIERE", "CAIDA", "CAIDO", "CAYO", "NO DESEA", "NO DESEA AVISA", "NO HIZO PEDIDO", "NO HA PEDIDO", "NO PIDIO", "DICE QUE NO PIDIO", "NO SABE DEL PEDIDO"] },
  { code: "cancelado", label: "Cancelado por el cliente", operational_status: "en_seguimiento", effect: "anulacion",
    aliases: ["CANCELADO", "CANCELO", "CANCELA", "ANULADO", "ANULO", "CLIENTE ANULA", "CNCELADO", "ANULA", "ANULADO SOLO PTO", "ANULADO//", "ANULADO MANANA"] },
  { code: "devuelto", label: "Devuelto a oficina", operational_status: "devuelto_al_origen", effect: "devolucion",
    aliases: ["DEVUELTO", "DEVOLUCION", "DEVUELTA", "RETORNADO"] },
  // Los cuatro que explicó la operación el 16-09-2026 tras la importación
  // histórica. Son el DETALLE de por qué no se entregó, no estados nuevos de
  // Kapta: por eso su equivalente es un operativo que ya existe.
  { code: "no_salio", label: "No salió a reparto (quedó en almacén)", operational_status: "nunca_salio_a_reparto", effect: "sin_salida",
    aliases: ["LO DEJA", "LO DEJO", "LO DEJ", "LO DEJA/MANANA", "SE QUEDO EN ALMACEN", "QUEDA EN ALMACEN", "DEJA EN ALMACEN", "NO SALIO", "NO SALE", "NO LO LLEVO"] },
  { code: "desarmar", label: "Desarmar en almacén: no se entregó", operational_status: "devuelto_al_origen", effect: "devolucion",
    aliases: ["DESARMAR", "PARA DESARMAR", "DESARMAR/ALEXIS", "DESARMAR ROY", "DESARMAR/ROY", "DESARMAR/ALICLICK", "DESARMADO"] },
  { code: "ya_recibio", label: "Cliente dice que ya recibió (otro delivery)", operational_status: "intento_de_entrega", effect: "informa",
    aliases: ["DICE QUE RECIBIO", "DICE QUE RECIBIBO", "DICE QUE RECIBIIO", "QUE YA RECIBIO", "YA RECIBIO", "YA LO RECIBIO", "YA LE LLEGO", "YA LO TIENE", "YA TIENE EL PEDIDO"] },
  { code: "repetido", label: "Pedido repetido: no se entregó", operational_status: "intento_de_entrega", effect: "informa",
    aliases: ["REPETIDO", "PEDIDO REPETIDO", "DUPLICADO", "MISMO CLIENTE", "MISMO CLIENTE PTO", "MISMO CLIENTE #", "MSIMO CLIENTE PTO"] },
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
    aliases: ["PENDIENTE", "ASIGNADO", "REGISTRADO", "GENERADO", "CREADO", "PROGRAMADO"] },
  { code: "despachado", label: "Despachado", operational_status: "despachado", effect: "informa",
    aliases: ["DESPACHADO", "SE ENVIO", "SE EMVIO", "ENVIADO", "RECOLECTADO", "RECOGIDO POR COURIER"] },
  { code: "en_transito", label: "En tránsito", operational_status: "en_transito", effect: "informa",
    aliases: ["EN TRANSITO", "TRANSITO", "IN TRANSIT", "EN VIAJE", "EN CAMINO"] },
  { code: "en_reparto", label: "En reparto", operational_status: "en_reparto", effect: "informa",
    aliases: ["EN REPARTO", "EN RUTA", "OUT FOR DELIVERY", "MOTORIZADO EN CAMINO"] },
  { code: "en_agencia", label: "En agencia / disponible para recojo", operational_status: "disponible_para_recojo", effect: "informa",
    aliases: ["EN AGENCIA", "DISPONIBLE PARA RECOJO", "LLEGO A AGENCIA", "EN DESTINO", "PARA RECOJO"] },
  { code: "no_contesta", label: "No contesta / intento fallido", operational_status: "intento_de_entrega", effect: "informa",
    aliases: ["NO CONTESTA", "NO RESPONDE", "NO CONTESTA PARA COORDINAR", "INTENTO FALLIDO", "AUSENTE", "DIRECCION INCORRECTA", "DIRECCION ERRADA", "NO RECIBE", "NO CONFIRMO", "NO ESTABA", "NO RESPOND", "NO RESPOMDE", "O RECIBE", "SIN INFO"] },
  { code: "reprogramado", label: "Reprogramado", operational_status: "reprogramado", effect: "informa",
    aliases: ["REPROGRAMADO", "REPRO", "REPROGRAMACION", "REAGENDADO", "NUEVA FECHA", "RE PRO", "REPRO R"] },
  { code: "cancelado", label: "Cancelado por el courier", operational_status: "en_seguimiento", effect: "anulacion",
    aliases: ["CANCELADO", "ANULADO", "CANCELADA", "ANULADA", "CANCELADO CLIENTE INDICA", "RECHAZADO", "RECHAZO", "CAIDA", "CAIDO", "NO DESEA", "RECHAZA", "CNCELADO", "CNELADO", "CANEALDO", "CANCELQADO", "CANCELADOC", "ANULADO SOLO", "ANULADO SOLO PTO"] },
  // Alexis y Urpi llevan cuaderno como los motorizados: «retirado» es que el
  // paquete vuelve a oficina sin intento de entrega, y sigue vivo.
  { code: "retirado", label: "Retirado de la ruta", operational_status: "pendiente_nuevo_courier", effect: "informa",
    aliases: ["RETIRADO", "RETIRADA"] },
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
    case "sin_salida":
      // El paquete no salió del almacén: no hubo intento (0177).
      return "0";
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
