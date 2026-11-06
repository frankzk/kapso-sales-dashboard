// «Llamar con Anura», fase 2: lo que dicen la ficha y Ajustes del teléfono
// DENTRO de Kapta (solo salidas). Puro y sin módulos de Node: lo importan
// componentes de cliente. Del servidor solo se toman TIPOS.
//
//   · La ficha decide el modo por `panel.kaptaPhone.status` (`anuraPhoneModeOf`):
//     `listo` → el teléfono vive en Kapta; `sin_telefono` → fase 1 sin cambios
//     (suena el teléfono de Anura de la asesora); `clave_rechazada` o
//     `sin_dominio` → no se llama y se dice por qué (con la «-websocket» como
//     principal, la fase 1 haría sonar una terminal sin registrar).
//   · Lo que dice la tarjeta en cada fase del teléfono, y el título de cada fallo.
//   · Ajustes: la chapa de cada anexo («clave guardada: sí/no», fecha, rechazo),
//     las credenciales de «Probar y guardar» armadas con lo escrito y por dónde
//     va la llamada de prueba.
//
// Lo prueba `test/anura-phone-ui.test.ts`.

import type { AnuraCallStatus } from "@/lib/anura/events";
import {
  ANURA_DEFAULT_ICE_SERVERS,
  normalizeAnuraWsUrl,
  normalizeSipDomain,
  normalizeSipPassword,
  normalizeSipPort,
  normalizeSipUser,
  type AnuraKaptaPhoneStatus,
} from "@/lib/anura/sip";
import { ANURA_PHONE_TEXT, type AnuraPhoneCredentials, type AnuraPhoneCredentialsErrorCode, type AnuraPhoneError, type AnuraPhoneSnapshot } from "@/lib/anura/sip-phone";
import { anuraStartErrorTitle } from "@/lib/anura/ui";

// ---------------------------------------------------------------------------
// La ficha
// ---------------------------------------------------------------------------

/**
 * Cómo llama «Llamar con Anura» para quien mira:
 *   · `kapta`: con el teléfono dentro de Kapta (micrófono y audífonos).
 *   · `fase1`: suena su teléfono de Anura (sin clave guardada, o sin la 0311).
 *   · `bloqueado`: hay clave pero no se puede usar (rechazada o sin dominio).
 */
export type AnuraCallWay = "kapta" | "fase1" | "bloqueado";

export function anuraPhoneModeOf(kaptaPhone: { status: AnuraKaptaPhoneStatus } | null | undefined): AnuraCallWay {
  switch (kaptaPhone?.status) {
    case "listo":
      return "kapta";
    case "clave_rechazada":
    case "sin_dominio":
      return "bloqueado";
    default:
      return "fase1";
  }
}

/** El título del aviso cuando no se puede llamar con el teléfono de Kapta. */
export const ANURA_PHONE_BLOCKED_TITLE: Record<"clave_rechazada" | "sin_dominio", string> = {
  clave_rechazada: "Anura rechazó la clave del teléfono de Kapta",
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

/**
 * La chapa de la tarjeta con el teléfono de Kapta. Mientras Kapta conecta,
 * manda la fase del teléfono; con Kapta ya en la llamada, el estado que trae
 * el sondeo de la fase 1 (Anura marca → la clienta contesta → termina).
 */
export function anuraPhoneStatusLabel(
  snapshot: Pick<AnuraPhoneSnapshot, "phase" | "toMasked"> | null,
  call: { status: AnuraCallStatus; statusLabel: string; active: boolean; toMasked?: string | null } | null,
): string {
  if (call && !call.active) return call.statusLabel;
  const phase = snapshot?.phase ?? "inactivo";
  switch (phase) {
    case "en_llamada":
      return call?.status === "en_curso" ? call.statusLabel : ANURA_PHONE_TEXT.llamando(snapshot?.toMasked ?? call?.toMasked ?? null);
    case "inactivo":
      // Una llamada retomada al abrir la ficha: lo que diga el sondeo.
      return call?.statusLabel ?? "";
    default:
      return PHASE_LABEL[phase];
  }
}

/** La línea de ayuda de la tarjeta con el teléfono de Kapta (no la de la fase 1). */
export function anuraPhoneHint(
  snapshot: Pick<AnuraPhoneSnapshot, "phase"> | null,
  call: { status: AnuraCallStatus; active: boolean } | null,
): string | null {
  const phase = snapshot?.phase ?? "inactivo";
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
      return call?.active ? "Colgaste. Kapta espera el aviso de fin de Anura para dejarla en el historial." : null;
    case "inactivo":
      return call?.active
        ? "Esta llamada se abrió antes de recargar la ficha o en otra pestaña. Si se cortó, Anura la cierra sola en un momento."
        : null;
    default:
      return null;
  }
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
  sin_dominio: ANURA_PHONE_BLOCKED_TITLE.sin_dominio,
  sin_telefono: "Tu anexo no tiene teléfono en Kapta",
  sin_anexo: "No tienes un anexo de Anura",
  no_configurado: "Anura no está configurado",
  permiso: "No puedes usar ese teléfono",
  sesion: "Tu sesión venció",
};

const REGISTRATION_TITLE = {
  clave: ANURA_PHONE_BLOCKED_TITLE.clave_rechazada,
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
      return anuraStartErrorTitle(error.start?.code);
    case "anura_no_llamo":
      return "Anura no hizo sonar el teléfono de Kapta";
    case "audio":
      return "No se pudo conectar el audio";
  }
}

/**
 * ¿Cambió el teléfono del anexo? Entonces la ficha vuelve a pedir su panel,
 * para que el botón sepa el modo nuevo (p. ej. «clave rechazada» → ya no se
 * intenta; «sin teléfono» → fase 1).
 */
export function anuraPhoneNeedsPanelReload(error: AnuraPhoneError | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "registro") return error.registration === "clave";
  if (error.code === "credenciales") {
    return error.credentialsCode === "clave_rechazada" || error.credentialsCode === "sin_dominio" || error.credentialsCode === "sin_telefono" || error.credentialsCode === "sin_anexo";
  }
  return false;
}

/** Los segundos hablados desde `answeredAt` (ISO del servidor). */
export function talkSecondsSince(iso: string | null | undefined, now: number): number {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : 0;
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
  } else if (phone.status === "sin_dominio") {
    lines.push("Falta el dominio SIP de la central: sin él no se puede llamar con el teléfono de Kapta.");
  }
  return lines;
}

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
