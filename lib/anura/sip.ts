// «Llamar con Anura», fase 2: el teléfono DENTRO de Kapta — las reglas puras
// de la configuración SIP. Sin red, sin secretos y sin módulos de Node: lo
// importan el servidor, Ajustes y la ficha por igual.
//
// QUÉ SE CONFIGURA (MOM §8.7, fase 2).
//   · Por organización (no es secreto): el dominio SIP de la central (el que
//     Anura muestra en «Obtener credenciales»), la URL WebSocket (por defecto
//     wss://sipwss.anura.pe; solo hosts de anura.pe y sin puerto, porque la
//     CSP solo deja salir a wss://*.anura.pe) y el puerto SIP (55090, Perú).
//     anura.dev es Argentina y NO sirve.
//   · Por anexo: el usuario SIP de la terminal web (por defecto
//     `<anexo>-websocket`) y su contraseña, que el servidor guarda cifrada.
//
// Lo prueba `test/anura-sip.test.ts`.

/** La señalización de Anura Perú. */
export const ANURA_DEFAULT_WS_URL = "wss://sipwss.anura.pe";
/** El puerto SIP de Anura Perú. */
export const ANURA_DEFAULT_SIP_PORT = 55090;
/** STUN público por defecto (no hay TURN propio: Anura tiene IP pública). */
export const ANURA_DEFAULT_ICE_SERVERS: readonly { urls: string }[] = [{ urls: "stun:stun.l.google.com:19302" }];

const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^${LABEL}(\\.${LABEL})+$`);
const SIP_USER_RE = /^[A-Za-z0-9._+-]{1,64}$/;
/** El largo máximo de una contraseña SIP que se acepta guardar. */
export const ANURA_SIP_PASSWORD_MAX = 128;

/**
 * El dominio SIP tal como lo pegan del panel: se quita «sip:», un usuario
 * («101-websocket@…»), el puerto y los espacios; en minúsculas. Null si no
 * parece un dominio.
 */
export function normalizeSipDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim().toLowerCase();
  v = v.replace(/^sips?:/, "").replace(/^[a-z]+:\/\//, "");
  const at = v.lastIndexOf("@");
  if (at >= 0) v = v.slice(at + 1);
  v = v.replace(/[/;?].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  if (v.length > 253 || !DOMAIN_RE.test(v)) return null;
  return v;
}

/**
 * ¿Este host es un subdominio de Anura Perú (sipwss.anura.pe…)? El dominio
 * raíz `anura.pe` no: la CSP (`wss://*.anura.pe`) no lo cubre y el navegador
 * bloquearía la conexión.
 */
export function isAnuraPeHost(host: string): boolean {
  const h = host.toLowerCase();
  return h.endsWith(".anura.pe") && h.length > ".anura.pe".length;
}

/**
 * La URL WebSocket: vacía = la de Perú. Solo `wss://`, a un host de anura.pe,
 * sin usuario ni puerto (la CSP no deja otro). Null si no sirve.
 */
export function normalizeAnuraWsUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined) return ANURA_DEFAULT_WS_URL;
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v) return ANURA_DEFAULT_WS_URL;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== "wss:" || u.username || u.password || u.search || u.hash) return null;
  if (u.port && u.port !== "443") return null;
  if (!isAnuraPeHost(u.hostname)) return null;
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  if (path && !/^\/[A-Za-z0-9._~/-]*$/.test(path)) return null;
  return `wss://${u.hostname.toLowerCase()}${path}`;
}

/** El puerto SIP: vacío = 55090. Null si no es un puerto. */
export function normalizeSipPort(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return ANURA_DEFAULT_SIP_PORT;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** El usuario SIP por defecto de la terminal web de un anexo. */
export function defaultSipUser(extension: string): string {
  return `${extension}-websocket`;
}

/** El usuario SIP: vacío = `<anexo>-websocket`. Null si no sirve. */
export function normalizeSipUser(raw: unknown, extension: string): string | null {
  if (raw === null || raw === undefined) return defaultSipUser(extension);
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/^sips?:/i, "");
  if (!v) return defaultSipUser(extension);
  return SIP_USER_RE.test(v) ? v : null;
}

/** ¿Es el usuario de la terminal web (`-websocket`)? Solo para avisar en Ajustes. */
export function looksLikeWebsocketUser(user: string): boolean {
  return /-websocket$/i.test(user.trim());
}

/**
 * La contraseña SIP: se quitan los espacios de los bordes (copiar y pegar);
 * null si queda vacía, es demasiado larga o trae saltos de línea.
 */
export function normalizeSipPassword(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > ANURA_SIP_PASSWORD_MAX || /[\r\n\t]/.test(v)) return null;
  return v;
}

// ---------------------------------------------------------------------------
// Lo que se ve
// ---------------------------------------------------------------------------

/**
 * El estado del teléfono de Kapta de un anexo, para la ficha y Ajustes:
 *   · `sin_telefono`: no hay clave guardada → fase 1 sin cambios (suena el
 *     teléfono de Anura de la asesora).
 *   · `listo`: hay clave y dominio → el teléfono vive en Kapta.
 *   · `clave_rechazada`: Anura rechazó la clave guardada; Kapta no la vuelve a
 *     usar hasta que se guarde otra.
 *   · `sin_dominio`: hay clave pero falta el dominio SIP de la central.
 */
export type AnuraKaptaPhoneStatus = "sin_telefono" | "listo" | "clave_rechazada" | "sin_dominio";

export const ANURA_KAPTA_PHONE_TEXT = {
  clave_rechazada: "Anura rechazó la clave del teléfono de Kapta; pide a quien administra que la vuelva a guardar.",
  sin_dominio: "Falta el dominio SIP de la central de Anura. Pide a quien administra que lo guarde en Ajustes › Telefonía Anura.",
  sin_telefono: "Este anexo no tiene teléfono en Kapta: suena tu teléfono de Anura.",
} as const;

/**
 * Lo que dice Ajustes al guardar o probar una clave: es la de la terminal
 * web, no la del anexo, y probar de más bloquea la oficina.
 */
export const ANURA_SIP_PASSWORD_HELP =
  "Usa la contraseña de la terminal «<anexo>-websocket» (Cuentas → anexo → Terminales → lápiz → «Obtener credenciales»), no la del teléfono físico. " +
  "Varios intentos con una clave mala hacen que Anura bloquee la conexión de la oficina: Kapta prueba una sola vez y no reintenta.";

/**
 * Lo que queda documentado en Ajustes y en el MOM: Kapta solo hace salidas.
 */
export const ANURA_KAPTA_PHONE_OUTBOUND_ONLY =
  "El teléfono de Kapta solo hace salidas: se conecta a Anura al pedir una llamada y se desconecta al terminar. " +
  "Con la «-websocket» como principal y Kapta desconectado, una llamada entrante a ese anexo NO suena en Kapta; " +
  "si quieres que una entrante llegue a alguien, configúralo en Anura («Flujo de llamada»).";
