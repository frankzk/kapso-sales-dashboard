// «Llamar con Anura», fase 2: lo que dicen la ficha y Ajustes del teléfono
// DENTRO de Kapta (solo salidas). Puro y sin módulos de Node: lo importan
// componentes de cliente. Del servidor solo se toman TIPOS.
//
//   · La ficha decide el modo por `panel.kaptaPhone.status` (`anuraPhoneModeOf`):
//     `listo` → el teléfono vive en Kapta; `sin_telefono` → fase 1 sin cambios
//     (suena el teléfono de Anura de la asesora); `clave_rechazada`,
//     `dominio_no_reconocido` o `sin_dominio` → no se llama y se dice por qué
//     (con la «-websocket» como principal, la fase 1 haría sonar una terminal
//     sin registrar).
//   · Lo que dice la tarjeta en cada fase del teléfono, el título de cada
//     fallo y desde cuándo corre su reloj (`anuraTalkClock`).
//   · Ajustes: la chapa de cada anexo («clave guardada: sí/no», fecha, rechazo),
//     las credenciales de «Probar y guardar» armadas con lo escrito y por dónde
//     va la llamada de prueba.
//
// Lo prueba `test/anura-phone-ui.test.ts`.

import { ANURA_STATUS_LABEL, type AnuraCallMode, type AnuraCallStatus } from "@/lib/anura/events";
import type { AnuraCallLive, AnuraStartErrorCode } from "@/lib/anura/calls";
import {
  ANURA_DEFAULT_ICE_SERVERS,
  isNotFoundAwaitingTest,
  normalizeAnuraWsUrl,
  normalizeSipDomain,
  normalizeSipPassword,
  normalizeSipPort,
  normalizeSipUser,
  type AnuraKaptaPhoneStatus,
} from "@/lib/anura/sip";
import {
  ANURA_KAPTA_START_TITLE,
  ANURA_PHONE_TEXT,
  type AnuraPhoneCredentials,   type AnuraPhoneCredentialsErrorCode,
  type AnuraPhoneError,
  type AnuraPhoneSnapshot,
} from "@/lib/anura/sip-phone";
import { anuraEndedLine, anuraStartErrorTitle } from "@/lib/anura/ui";

// ---------------------------------------------------------------------------
// La ficha
// ---------------------------------------------------------------------------

/**
 * Cómo llama «Llamar con Anura» para quien mira:
 *   · `kapta`: con el teléfono dentro de Kapta (micrófono y audífonos).
 *   · `fase1`: suena su teléfono de Anura (sin clave guardada, o sin la 0311).
 *   · `bloqueado`: hay clave pero no se puede usar (rechazada, dominio no
 *     reconocido o sin dominio).
 */
export type AnuraCallWay = "kapta" | "fase1" | "bloqueado";

export function anuraPhoneModeOf(kaptaPhone: { status: AnuraKaptaPhoneStatus } | null | undefined): AnuraCallWay {
  switch (kaptaPhone?.status) {
    case "listo":
      return "kapta";
    case "clave_rechazada":
    case "dominio_no_reconocido":
    case "sin_dominio":
      return "bloqueado";
    default:
      return "fase1";
  }
}

/** Los estados con clave guardada que no dejan llamar. */
export type AnuraPhoneBlockedStatus = Extract<AnuraKaptaPhoneStatus, "clave_rechazada" | "dominio_no_reconocido" | "sin_dominio">;

export function isAnuraPhoneBlocked(status: AnuraKaptaPhoneStatus | null | undefined): status is AnuraPhoneBlockedStatus {
  return status === "clave_rechazada" || status === "dominio_no_reconocido" || status === "sin_dominio";
}

/** El título del aviso cuando no se puede llamar con el teléfono de Kapta. */
export const ANURA_PHONE_BLOCKED_TITLE: Record<AnuraPhoneBlockedStatus, string> = {
  clave_rechazada: "Anura rechazó la clave del teléfono de Kapta",
  dominio_no_reconocido: "Anura no reconoce el usuario o el dominio",
  sin_dominio: "Falta el dominio de Anura",
};

/** Lo que espera el teléfono, en una palabra, para la chapa de la tarjeta. */
const PHASE_LABEL: Record<AnuraPhoneSnapshot["phase"], string> = {
  inactivo: "",
  credenciales: ANURA_PHONE_TEXT.conectando,
  microfono: "Pidiendo el micrófono…",
  conectando: ANURA_PHONE_TEXT.conectando,
  pidiendo: "Pidiendo la llamada…",
  esperando_anura: ANURA_PHONE_TEXT.esperando_anura,
  en_llamada: "",
  terminada: "Colgaste",
  error: "No se pudo llamar",
};

/** Quién cortó, para la chapa y la ayuda al terminar. */
type EndedBy = { endedBy?: AnuraPhoneSnapshot["endedBy"] };

/** El estado de la llamada que trae el sondeo (lo que estas funciones leen). */
type PolledCall = { status: AnuraCallStatus; statusLabel: string; active: boolean; toMasked?: string | null; closedByTimeout?: boolean };

/**
 * Kapta sigue en la llamada aunque el servidor la cerró solo por su plazo
 * (no llegó ningún aviso de Anura): el audio vale más que la fila. La ficha
 * no cuelga por eso; la asesora cuelga desde Kapta.
 */
export function anuraPhoneOutlivesServer(
  snapshot: Pick<AnuraPhoneSnapshot, "phase"> | null,
  call: { active: boolean; closedByTimeout?: boolean } | null,
): boolean {
  return snapshot?.phase === "en_llamada" && Boolean(call && !call.active && call.closedByTimeout);
}

/**
 * La chapa de la tarjeta con el teléfono de Kapta. Mientras Kapta conecta,
 * manda la fase del teléfono; con Kapta ya en la llamada, el estado que trae
 * el sondeo de la fase 1 (Anura marca → la clienta contesta → termina).
 */
export function anuraPhoneStatusLabel(
  snapshot: (Pick<AnuraPhoneSnapshot, "phase" | "toMasked"> & EndedBy) | null,
  call: PolledCall | null,
): string {
  if (anuraPhoneOutlivesServer(snapshot, call)) return "En llamada";
  if (call && !call.active) return call.statusLabel;
  const phase = snapshot?.phase ?? "inactivo";
  switch (phase) {
    case "en_llamada":
      return call?.status === "en_curso" ? call.statusLabel : ANURA_PHONE_TEXT.llamando(snapshot?.toMasked ?? call?.toMasked ?? null);
    case "terminada":
      return snapshot?.endedBy === "anura" ? "Llamada terminada" : PHASE_LABEL.terminada;
    case "inactivo":
      // Una llamada retomada al abrir la ficha: lo que diga el sondeo.
      return call?.statusLabel ?? "";
    default:
      return PHASE_LABEL[phase];
  }
}

/** La línea de ayuda de la tarjeta con el teléfono de Kapta (no la de la fase 1). */
export function anuraPhoneHint(
  snapshot: (Pick<AnuraPhoneSnapshot, "phase"> & EndedBy) | null,
  call: { status: AnuraCallStatus; active: boolean; closedByTimeout?: boolean } | null,
): string | null {
  const phase = snapshot?.phase ?? "inactivo";
  if (anuraPhoneOutlivesServer(snapshot, call)) {
    return "Kapta no recibió los avisos de Anura de esta llamada, pero sigues en ella. Cuelga desde aquí al terminar.";
  }
  switch (phase) {
    case "credenciales":
    case "microfono":
      return "Si el navegador lo pregunta, permite el micrófono. Usa audífonos con micrófono.";
    case "conectando":
    case "pidiendo":
    case "esperando_anura":
      return "Kapta se conecta a Anura solo para esta llamada y se desconecta al colgar.";
    case "en_llamada":
      return call?.status === "en_curso"
        ? "Hablas desde Kapta. Al colgar, registra el resultado en la confirmación."
        : "Anura está marcando a la clienta: oirás su timbre por tus audífonos.";
    case "terminada":
      if (!call?.active) return null;
      return snapshot?.endedBy === "anura"
        ? "Anura terminó la llamada. Kapta espera su aviso de fin para dejarla en el historial."
        : "Colgaste. Kapta espera el aviso de fin de Anura para dejarla en el historial.";
    case "inactivo":
      return call?.active ? ANURA_PHONE_RESUMED_HINT : null;
    default:
      return null;
  }
}

/**
 * Una llamada viva retomada al abrir la ficha (otra pestaña, o antes de
 * recargar): esta pestaña no tiene su audio ni puede colgarla.
 */
export const ANURA_PHONE_RESUMED_HINT =
  "Esta llamada está abierta en otra pestaña de Kapta o se abrió antes de recargar la ficha: cuélgala desde la pestaña donde la abriste. Si se cortó, Anura la cierra sola en un momento.";

/**
 * Cómo terminó, con el teléfono de Kapta. Si la cerró el plazo del servidor
 * (sin avisos de Anura), el motivo de la fase 1 habla de «tu teléfono de
 * Anura», que aquí no existe.
 */
export function anuraPhoneEndedLine(
  call: { status: AnuraCallStatus; billSeconds: number | null; failureReason: string | null; closedByTimeout?: boolean },
): string {
  if (call.status === "fallida" && call.closedByTimeout) {
    return "No se pudo llamar: Kapta no recibió los avisos de Anura de esta llamada y la cerró sola. Vuelve a intentar.";
  }
  return anuraEndedLine(call);
}

/** ¿Se puede silenciar? Solo con Kapta en la llamada. */
export function anuraPhoneCanMute(snapshot: Pick<AnuraPhoneSnapshot, "phase"> | null): boolean {
  return snapshot?.phase === "en_llamada";
}

/** El botón rojo: «Cancelar» mientras conecta, «Colgar» con Kapta en la llamada. */
export function anuraPhoneHangUpLabel(snapshot: Pick<AnuraPhoneSnapshot, "phase"> | null): "Colgar" | "Cancelar" {
  return snapshot?.phase === "en_llamada" ? "Colgar" : "Cancelar";
}

const CREDENTIALS_TITLE: Partial<Record<AnuraPhoneCredentialsErrorCode, string>> = {
  clave_rechazada: ANURA_PHONE_BLOCKED_TITLE.clave_rechazada,
  dominio_no_reconocido: ANURA_PHONE_BLOCKED_TITLE.dominio_no_reconocido,
  sin_dominio: ANURA_PHONE_BLOCKED_TITLE.sin_dominio,
  sin_telefono: "Tu anexo no tiene teléfono en Kapta",
  sin_anexo: "No tienes un anexo de Anura",
  no_configurado: "Anura no está configurado",
  permiso: "No puedes usar ese teléfono",
  sesion: "Tu sesión venció",
};

const REGISTRATION_TITLE = {
  clave: ANURA_PHONE_BLOCKED_TITLE.clave_rechazada,
  dominio: ANURA_PHONE_BLOCKED_TITLE.dominio_no_reconocido,
  red: "Sin conexión con Anura",
  tiempo: "Anura no respondió",
  otro: "No se pudo conectar el teléfono de Kapta",
} as const;

/** El título del aviso de un fallo del teléfono de Kapta. El detalle es `error.message`. */
export function anuraPhoneErrorTitle(error: AnuraPhoneError): string {
  switch (error.code) {
    case "otra_pestana":
      return "Ya tienes una llamada abierta";
    case "credenciales":
      return (error.credentialsCode && CREDENTIALS_TITLE[error.credentialsCode]) || "No se pudo preparar el teléfono de Kapta";
    case "microfono_denegado":
      return "Kapta no tiene permiso para el micrófono";
    case "microfono_no_disponible":
      return "No hay micrófono";
    case "registro":
      return REGISTRATION_TITLE[error.registration ?? "otro"];
    case "llamada_rechazada":
      return (error.start?.code && ANURA_KAPTA_START_TITLE[error.start.code]) || anuraStartErrorTitle(error.start?.code);
    case "anura_no_llamo":
      return "Anura no hizo sonar el teléfono de Kapta";
    case "audio":
      return "No se pudo conectar el audio";
    case "espera":
      return "Espera un momento";
  }
}

/**
 * ¿Cambió el teléfono del anexo? Entonces la ficha vuelve a pedir su panel,
 * para que el botón sepa el modo nuevo (p. ej. «clave rechazada» → ya no se
 * intenta; «sin teléfono» → fase 1).
 */
export function anuraPhoneNeedsPanelReload(error: AnuraPhoneError | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "registro") return error.registration === "clave" || error.registration === "dominio";
  if (error.code === "credenciales") {
    return isAnuraPhoneBlocked(error.credentialsCode as AnuraKaptaPhoneStatus) || error.credentialsCode === "sin_telefono" || error.credentialsCode === "sin_anexo";
  }
  return false;
}

/** Los segundos hablados desde `answeredAt` (ISO del servidor). */
export function talkSecondsSince(iso: string | null | undefined, now: number): number {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : 0;
}

/**
 * El reloj de la tarjeta (ficha y llamada de prueba de Ajustes): si corre y
 * desde cuándo (ms).
 *   · Con la llamada `en_curso` según los avisos de Anura: desde el
 *     `answeredAt` del servidor (el TALK), hasta que la asesora cuelga.
 *   · Con el teléfono de Kapta todavía en la llamada aunque el servidor la
 *     cerró solo por su plazo (`anuraPhoneOutlivesServer`: no llegó ningún
 *     aviso de Anura): desde que el teléfono de Kapta contestó
 *     (`snapshot.answeredAt`), porque el servidor no sabe cuándo empezó.
 * `fromMs` null con el reloj corriendo: no se sabe desde cuándo (marca 0:00).
 */
export function anuraTalkClock(
  snapshot: Pick<AnuraPhoneSnapshot, "phase" | "answeredAt"> | null,
  call: { status: AnuraCallStatus; active: boolean; answeredAt: string | null; closedByTimeout?: boolean } | null,
  viaKapta: boolean,
): { running: boolean; fromMs: number | null } {
  const serverAt = call?.answeredAt ? Date.parse(call.answeredAt) : NaN;
  const server = Number.isFinite(serverAt) ? serverAt : null;
  if (viaKapta && anuraPhoneOutlivesServer(snapshot, call)) {
    return { running: true, fromMs: snapshot?.answeredAt ?? server };
  }
  if (call?.status === "en_curso" && !(viaKapta && snapshot?.phase === "terminada")) {
    return { running: true, fromMs: server ?? (viaKapta ? snapshot?.answeredAt ?? null : null) };
  }
  return { running: false, fromMs: null };
}

/** Los segundos del reloj de la tarjeta (`anuraTalkClock`). */
export function talkSecondsFrom(fromMs: number | null | undefined, now: number): number {
  return typeof fromMs === "number" && Number.isFinite(fromMs) ? Math.max(0, Math.round((now - fromMs) / 1000)) : 0;
}

// ---------------------------------------------------------------------------
// La llamada vive en Kapta, no en la ficha (07-11-2026)
// ---------------------------------------------------------------------------
//
// El teléfono de Kapta es UNO por pestaña y vive en el panel
// (`AnuraPhoneProvider`, components/anura-phone.tsx, montado en
// app/dashboard/layout.tsx). Cerrar la ficha, abrir otro pedido o ir a otra
// pantalla NO corta la llamada; solo «Colgar», el otro lado, un fallo o
// cerrar/recargar la pestaña. Estas funciones deciden quién la muestra.

/** Desde dónde se pidió la llamada que tiene el teléfono de Kapta. */
export type AnuraPhoneOrigin = "pedido" | "prueba";

/** Lo que el panel sabe de la llamada del teléfono de Kapta (sin el número entero). */
export interface AnuraPhoneCallMeta {
  origin: AnuraPhoneOrigin;
  /** El pedido (null en la llamada de prueba de Ajustes). */
  orderId: string | null;
  /** «#KP123456», si quien llamó lo tenía a mano. */
  orderLabel: string | null;
  /** El nombre de la tienda del pedido, si se sabe. */
  storeLabel: string | null;
}

/** ¿Es esta la llamada de esa pantalla? (la ficha de ese pedido, o la prueba de Ajustes). */
export function anuraPhoneCallIsFor(
  meta: Pick<AnuraPhoneCallMeta, "origin" | "orderId"> | null | undefined,
  who: { origin: AnuraPhoneOrigin; orderId?: string | null },
): boolean {
  if (!meta || meta.origin !== who.origin) return false;
  if (meta.origin === "prueba") return true;
  return Boolean(meta.orderId) && meta.orderId === who.orderId;
}

/**
 * Qué hace «Llamar con Anura» en una ficha según el teléfono de Kapta:
 *   · `mostrar`: la llamada en marcha es de este pedido → se enseña.
 *   · `ocupado`: hay una llamada en marcha de OTRO pedido (o la prueba de
 *     Ajustes) → no se pide otra; la tarjeta de esa llamada lo dice.
 *   · `llamar`: el teléfono está libre.
 */
export function anuraPhoneStartDecision(input: { phoneBusy: boolean; isThisCall: boolean }): "mostrar" | "ocupado" | "llamar" {
  if (!input.phoneBusy) return "llamar";
  return input.isThisCall ? "mostrar" : "ocupado";
}

/** El aviso cuando ya hay una llamada en marcha y se intenta otra. */
export const ANURA_PHONE_BUSY_TITLE = ANURA_KAPTA_START_TITLE.ocupada ?? "Ya tienes una llamada abierta";

export function anuraPhoneBusyText(meta: Pick<AnuraPhoneCallMeta, "origin" | "orderLabel"> | null | undefined): string {
  const which =
    meta?.origin === "prueba" ? "la llamada de prueba" : meta?.orderLabel ? `la llamada del pedido ${meta.orderLabel}` : "una llamada con Anura";
  return `Estás en ${which}. Kapta hace una llamada a la vez: cuélgala antes de llamar a otro cliente.`;
}

/** La segunda línea de la tarjeta global: de qué es la llamada. */
export function anuraPhoneCallContextLine(meta: AnuraPhoneCallMeta | null | undefined): string | null {
  if (!meta) return null;
  if (meta.origin === "prueba") return "Llamada de prueba (Ajustes › Telefonía Anura)";
  const parts = [meta.orderLabel ? `Pedido ${meta.orderLabel}` : "Pedido", meta.storeLabel].filter(Boolean);
  return parts.join(" · ");
}

/** Lo que dicen las dos tarjetas mientras el teléfono de Kapta está en la llamada. */
export const ANURA_PHONE_KEEPS_GOING =
  "Puedes cerrar la ficha o ir a otra pantalla: la llamada sigue. Se corta si cuelgas, si cuelga la clienta o si cierras o recargas la pestaña.";

/**
 * ¿Se pinta la tarjeta global? Solo si hay una llamada en marcha (o una que
 * terminó sin que ninguna pantalla la mostrara), y ninguna pantalla la está
 * mostrando ya (la ficha de ese pedido o la prueba de Ajustes): nunca dos
 * tarjetas de la misma llamada. El aviso de «ya tienes una llamada» la saca
 * aunque otra pantalla la muestre.
 */
export function anuraGlobalCardVisible(input: {
  hasSession: boolean;
  busy: boolean;
  endedUnseen: boolean;
  shownElsewhere: boolean;
  busyNotice: boolean;
}): boolean {
  if (!input.hasSession || !(input.busy || input.endedUnseen)) return false;
  return !input.shownElsewhere || input.busyNotice;
}

/**
 * La llamada recién pedida, hasta que el primer sondeo traiga la de verdad.
 * El número llega ya enmascarado del servidor.
 */
export function anuraRequestedCall(input: {
  id: string;
  mode: AnuraCallMode;
  orderId: string | null;
  extension: string | null;
  toMasked: string | null;
  hint: string | null;
  nowIso?: string;
}): AnuraCallLive {
  return {
    id: input.id,
    mode: input.mode,
    orderId: input.orderId,
    inHistory: false,
    status: "solicitada",
    statusLabel: ANURA_STATUS_LABEL.solicitada,
    hint: input.hint,
    active: true,
    extension: input.extension,
    toMasked: input.toMasked ?? "",
    billSeconds: null,
    failureReason: null,
    requestedAt: input.nowIso ?? new Date().toISOString(),
    answeredAt: null,
    endedAt: null,
    recordingStatus: "sin_grabacion",
    closedByTimeout: false,
  };
}

// ---------------------------------------------------------------------------
// Fase 1 sin clave del teléfono de Kapta (07-11-2026)
// ---------------------------------------------------------------------------

/**
 * Con la «<anexo>-websocket» como terminal principal y SIN la clave guardada
 * en Kapta, la fase 1 pide la llamada, Anura no ve esa terminal conectada y
 * el texto de siempre («Tu teléfono de Anura no está conectado») confunde:
 * lo que falta es la clave del teléfono de Kapta.
 */
export const ANURA_KAPTA_KEY_MISSING_TITLE = "Falta la clave del teléfono de Kapta";

const KEY_MISSING_CODES: readonly AnuraStartErrorCode[] = ["terminal_no_registrada", "sin_terminal"];

export function anuraKaptaKeyMissingText(code: "terminal_no_registrada" | "sin_terminal", extension: string | null | undefined): string {
  const ext = extension?.trim() || null;
  const anexo = ext ? `El anexo ${ext}` : "Tu anexo";
  const terminal = `«${ext ?? "<anexo>"}-websocket»`;
  if (code === "sin_terminal") {
    return `${anexo} no tiene terminal principal en Anura ni clave del teléfono de Kapta. Marca la ${terminal} como principal en Anura y guarda su clave en Ajustes › Telefonía Anura.`;
  }
  return `${anexo} no tiene guardada la clave de su teléfono de Kapta, así que Anura no ve conectada la terminal ${terminal}. Guárdala en Ajustes › Telefonía Anura. Si usas un teléfono de Anura, ábrelo y espera a que diga «Listo».`;
}

/**
 * El aviso de un Click2Dial fallido en la fase 1. `kaptaKeyMissing`: el anexo
 * no tiene la clave del teléfono de Kapta guardada (`sin_telefono`).
 */
export function anuraFase1StartError(
  res: { code?: AnuraStartErrorCode; error: string },
  input: { kaptaKeyMissing: boolean; extension: string | null | undefined },
): { title: string; text: string } {
  if (input.kaptaKeyMissing && res.code && KEY_MISSING_CODES.includes(res.code)) {
    return { title: ANURA_KAPTA_KEY_MISSING_TITLE, text: anuraKaptaKeyMissingText(res.code as "terminal_no_registrada" | "sin_terminal", input.extension) };
  }
  return { title: anuraStartErrorTitle(res.code), text: res.error };
}

// ---------------------------------------------------------------------------
// La grabación (ruta del mismo origen)
// ---------------------------------------------------------------------------

/**
 * La dirección del reproductor. La ruta `/api/anura/recordings/<id>` firma
 * cada pedido en el servidor, así que no vence; tras un error se vuelve a
 * pedir con otra marca para que el navegador no reuse la respuesta fallida.
 */
export function anuraRecordingSrc(url: string, attempt: number): string {
  if (!attempt) return url;
  return `${url}${url.includes("?") ? "&" : "?"}intento=${attempt}`;
}

/** Cuántas veces se ofrece «Volver a cargar» antes de decir que no está. */
export const ANURA_RECORDING_MAX_RETRIES = 2;

// ---------------------------------------------------------------------------
// Ajustes
// ---------------------------------------------------------------------------

export interface AnuraExtensionPhoneLike {
  status: AnuraKaptaPhoneStatus;
  sipUser: string;
  hasPassword: boolean;
  savedAt: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
}

/** La chapa del teléfono de Kapta de un anexo en Ajustes. Nunca la clave. */
export function anuraSipPhoneBadge(phone: Pick<AnuraExtensionPhoneLike, "status" | "hasPassword">): { label: string; tone: "neutral" | "ok" | "warn" | "crit" } {
  if (!phone.hasPassword) return { label: "Sin teléfono en Kapta", tone: "neutral" };
  switch (phone.status) {
    case "listo":
      return { label: "Teléfono en Kapta", tone: "ok" };
    case "clave_rechazada":
      return { label: "Clave rechazada", tone: "crit" };
    case "dominio_no_reconocido":
      return { label: "Revisa el dominio", tone: "crit" };
    case "sin_dominio":
      return { label: "Falta el dominio", tone: "warn" };
    default:
      return { label: "Sin teléfono en Kapta", tone: "neutral" };
  }
}

/**
 * La línea debajo del anexo: «Clave guardada: sí/no», cuándo, y si Anura la
 * rechazó (cuándo y por qué). `when` formatea la fecha.
 */
export function anuraSipPhoneLines(phone: AnuraExtensionPhoneLike, when: (iso: string | null) => string): string[] {
  if (!phone.hasPassword) {
    return ["Clave guardada: no. Al llamar suena su teléfono de Anura (sin teléfono en Kapta)."];
  }
  const lines = [`Clave guardada: sí · ${when(phone.savedAt)} · usuario ${phone.sipUser}`];
  if (phone.status === "clave_rechazada") {
    lines.push(
      `Anura la rechazó el ${when(phone.rejectedAt)}${phone.rejectedReason ? `: ${phone.rejectedReason}` : "."} Kapta no la vuelve a usar hasta que guardes otra.`,
    );
  } else if (phone.status === "dominio_no_reconocido") {
    const code = /\(SIP \d+\)/.exec(phone.rejectedReason ?? "")?.[0];
    lines.push(
      isNotFoundAwaitingTest(phone.rejectedReason)
        ? `Anura no reconoció el usuario ${phone.sipUser} con el dominio anterior de la central el ${when(phone.rejectedAt)}${code ? ` ${code}` : ""}. ${ANURA_DOMAIN_RETEST_FIX}`
        : `Anura no reconoció el usuario ${phone.sipUser} en el dominio de la central el ${when(phone.rejectedAt)}${code ? ` ${code}` : ""}. ${ANURA_DOMAIN_NOT_FOUND_FIX}`,
    );
  } else if (phone.status === "sin_dominio") {
    lines.push("Falta el dominio SIP de la central: sin él no se puede llamar con el teléfono de Kapta.");
  }
  return lines;
}

/**
 * El aviso junto al dominio de la central cuando Anura no reconoció anexos.
 * `awaitingTest`: cuántos de ellos se marcaron con un dominio anterior y
 * esperan que Anura acepte el que está guardado ahora.
 */
export function anuraDomainNotFoundBanner(count: number, awaitingTest = 0): string {
  const who = count === 1 ? "un anexo" : `${count} anexos`;
  if (awaitingTest >= count) {
    return (
      `Se cambió el dominio de la central y ${count === 1 ? "queda un anexo" : `quedan ${count} anexos`} que Anura no reconocía con el anterior (SIP 404). ` +
      "Prueba el dominio nuevo con «Probar y guardar» en un anexo: cuando Anura lo acepte, los demás se vuelven a probar en su próxima llamada, sin volver a escribir sus claves."
    );
  }
  return (
    `Anura no reconoció ${who} con este dominio (SIP 404): lo más probable es que el dominio esté mal escrito. ` +
    "Cópialo de «Obtener credenciales» de la terminal «-websocket», pulsa «Guardar central» y pruébalo con «Probar y guardar» en un anexo: " +
    "cuando Anura lo acepte, los demás se vuelven a probar en su próxima llamada, sin volver a escribir sus claves."
  );
}

/**
 * Qué hacer en Ajustes con un «dominio no reconocido» (SIP 404). No es la
 * contraseña: es el dominio de la central (arriba) o el usuario.
 */
export const ANURA_DOMAIN_NOT_FOUND_FIX =
  "Revisa el «Dominio SIP de la central» de arriba (tal como sale en «Obtener credenciales») y que el usuario sea el de la terminal «-websocket». " +
  "Guarda el dominio corregido y pruébalo con «Probar y guardar» en un anexo: cuando Anura lo acepte, este anexo se vuelve a probar en su próxima llamada. " +
  "Si el dominio estaba bien, corrige el usuario de este anexo y usa «Probar y guardar». " +
  "Kapta no reintenta solo, para que Anura no bloquee la conexión de la oficina.";

/** Lo mismo cuando el dominio ya se cambió después de la marca: falta probarlo. */
export const ANURA_DOMAIN_RETEST_FIX =
  "Ya se guardó otro dominio: pruébalo con «Probar y guardar» en un anexo. Cuando Anura lo acepte, este anexo se vuelve a probar en su próxima llamada, " +
  "sin volver a escribir su clave. Kapta no reintenta solo, para que Anura no bloquee la conexión de la oficina.";

/**
 * «Probar y guardar» recuerda, en memoria de la pantalla, cada combinación
 * que Anura rechazó (dominio, usuario y contraseña; la contraseña como huella,
 * no en claro): repetirla tal cual es el patrón que hace que Anura bloquee la
 * conexión de la oficina, así que el botón no deja hasta que algo cambie.
 */
export function anuraSipTestKey(creds: Pick<AnuraPhoneCredentials, "extension" | "sipUser" | "domain" | "password">): string {
  // FNV-1a de 32 bits: solo para comparar en esta pantalla, no es secreto ni se guarda.
  let h = 0x811c9dc5;
  for (let i = 0; i < creds.password.length; i += 1) {
    h ^= creds.password.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${creds.extension}\u0000${creds.sipUser.toLowerCase()}\u0000${creds.domain.toLowerCase()}\u0000${h.toString(16)}`;
}

export const ANURA_SIP_TEST_REPEAT_TEXT =
  "Anura ya rechazó este mismo dominio, usuario y contraseña. Cambia el dominio de la central, el usuario o la contraseña antes de volver a probar: " +
  "repetir la misma prueba puede hacer que Anura bloquee la conexión de la oficina.";

/** La central SIP tal como la escribe quien administra (texto de los campos). */
export interface AnuraSipCentralDraft {
  domain: string;
  wsUrl: string;
  port: string;
}

export type AnuraSipCentralParsed = { ok: true; domain: string; wsUrl: string; port: number } | { ok: false; error: string };

/** Valida la central antes de mandarla (el servidor vuelve a validar). */
export function parseAnuraSipCentral(draft: AnuraSipCentralDraft): AnuraSipCentralParsed {
  const domain = normalizeSipDomain(draft.domain);
  if (!domain) return { ok: false, error: "Escribe el dominio de la central tal como sale en «Obtener credenciales» (por ejemplo, miempresa.anura.pe)." };
  const wsUrl = normalizeAnuraWsUrl(draft.wsUrl);
  if (!wsUrl) return { ok: false, error: "La URL WebSocket tiene que ser wss:// a un servidor de anura.pe (por defecto, wss://sipwss.anura.pe)." };
  const port = normalizeSipPort(draft.port.trim());
  if (!port) return { ok: false, error: "El puerto SIP es un número de 1 a 65535 (en Perú, 55090)." };
  return { ok: true, domain, wsUrl, port };
}

/**
 * Las credenciales para el único intento de registro de «Probar y guardar»,
 * con lo que escribió quien administra. Solo viven en memoria durante la
 * prueba; no hay `credentialVersion` porque todavía no se guardó nada.
 */
export function anuraSipTestCredentials(
  draft: AnuraSipCentralDraft,
  extension: string,
  sipUser: string,
  password: string,
): { ok: true; creds: AnuraPhoneCredentials; sipUser: string } | { ok: false; error: string } {
  const central = parseAnuraSipCentral(draft);
  if (!central.ok) return central;
  const user = normalizeSipUser(sipUser, extension);
  if (!user) return { ok: false, error: "El usuario SIP solo lleva letras, números, punto, guion o guion bajo (por ejemplo, 101-websocket)." };
  const pass = normalizeSipPassword(password);
  if (!pass) return { ok: false, error: "Escribe la contraseña SIP de la terminal web (hasta 128 caracteres, sin saltos de línea)." };
  return {
    ok: true,
    sipUser: user,
    creds: {
      extension,
      sipUser: user,
      password: pass,
      domain: central.domain,
      wsUrl: central.wsUrl,
      port: central.port,
      iceServers: ANURA_DEFAULT_ICE_SERVERS.map((s) => ({ ...s })),
      credentialVersion: "",
    },
  };
}

/**
 * Por dónde va la «Llamada de prueba» de Ajustes:
 *   · `kapta`: el anexo elegido tiene clave guardada → teléfono de Kapta (el
 *     servidor solo entrega la clave si el anexo es de quien prueba).
 *   · `kapta_o_fase1`: «Mi anexo»: se intenta el teléfono de Kapta y, si el
 *     anexo propio no tiene clave (o no hay anexo), sigue como en la fase 1.
 *   · `fase1`: el anexo elegido no tiene clave, o falta la 0311.
 */
export type AnuraTestCallWay = "kapta" | "kapta_o_fase1" | "fase1";

export function anuraTestCallWay(
  selectedExtension: string,
  extensions: readonly { extension: string; phone: Pick<AnuraExtensionPhoneLike, "hasPassword"> }[],
  sipMigrationMissing: boolean,
): AnuraTestCallWay {
  if (sipMigrationMissing) return "fase1";
  if (!selectedExtension) return "kapta_o_fase1";
  const ext = extensions.find((e) => e.extension === selectedExtension);
  return ext?.phone.hasPassword ? "kapta" : "fase1";
}

/** Con «Mi anexo»: lo que el servidor responde cuando hay que seguir como en la fase 1. */
export const ANURA_TEST_FALLBACK_CODES: readonly AnuraPhoneCredentialsErrorCode[] = ["sin_telefono", "sin_anexo"];

export function anuraTestFallsBack(error: AnuraPhoneError | null | undefined): boolean {
  return error?.code === "credenciales" && !!error.credentialsCode && ANURA_TEST_FALLBACK_CODES.includes(error.credentialsCode);
}

// ---------------------------------------------------------------------------
// Volumen de lo que se oye (07-11-2026: la línea llega bajita). Ganancia del
// amplificador de Web Audio: 1 = tal cual, hasta 4×. Por defecto 2,5×.
// ---------------------------------------------------------------------------

export const ANURA_VOLUME_MIN = 1;
export const ANURA_VOLUME_MAX = 4;
export const ANURA_VOLUME_STEP = 0.25;
export const ANURA_VOLUME_DEFAULT = 2.5;

/** Un volumen válido (1–4, en pasos de 0,25); lo que no es número vuelve al de defecto. */
export function clampAnuraVolume(v: number): number {
  if (!Number.isFinite(v)) return ANURA_VOLUME_DEFAULT;
  const stepped = Math.round(v / ANURA_VOLUME_STEP) * ANURA_VOLUME_STEP;
  return Math.min(ANURA_VOLUME_MAX, Math.max(ANURA_VOLUME_MIN, stepped));
}
