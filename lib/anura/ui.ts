// «Llamar con Anura», fase 1: los textos y las cuentas de la ficha y de
// Ajustes. Puro y sin módulos de Node: lo importan componentes de cliente.
// Del servidor (`lib/anura/server.ts`, `lib/anura/calls.ts`) solo se toman
// TIPOS: `import type` se borra al compilar y no arrastra nada al navegador.
//
// Lo prueba `test/anura-ui.test.ts`.

import type { AnuraStartErrorCode } from "@/lib/anura/calls";
import type { AnuraCallStatus, AnuraRecordingStatus } from "@/lib/anura/events";
import { talkTimeWords } from "@/lib/browser-call";

/**
 * El título del aviso cuando Anura no llegó a hacer sonar el teléfono. El
 * detalle (qué hacer) lo trae el servidor en `error`.
 */
export const ANURA_START_ERROR_TITLE: Record<AnuraStartErrorCode, string> = {
  ocupada: "Ya tienes una llamada en curso",
  linea_ocupada: "Ese anexo está en otra llamada",
  lineas_ocupadas: "Líneas de Anura ocupadas",
  sin_lineas: "No hay líneas de Anura listas",
  reserva: "La línea de Anura se liberó",
  base: "No se pudo pedir la llamada",
  sin_token: "Anura no está configurado",
  token: "El token de Anura no es válido",
  sin_terminal: "Tu anexo no tiene terminal principal",
  terminal_no_registrada: "Tu teléfono de Anura no está conectado",
  tiempo: "Anura no respondió",
  rechazo: "Anura rechazó la llamada",
  red: "No se supo si Anura recibió la llamada",
};

export function anuraStartErrorTitle(code: AnuraStartErrorCode | undefined): string {
  return code ? ANURA_START_ERROR_TITLE[code] : "No se pudo llamar";
}

/** Cómo terminó, en una línea, para el aviso de la ficha y la Llamada de prueba. */
export function anuraEndedLine(call: { status: AnuraCallStatus; billSeconds: number | null; failureReason: string | null }): string {
  switch (call.status) {
    case "contestada":
      return (call.billSeconds ?? 0) > 0 ? `Contestó · ${talkTimeWords(call.billSeconds ?? 0)} de conversación` : "Contestó";
    case "no_contestada":
      return "No contestó";
    case "ocupado":
      return "Ocupado";
    case "perdida":
      return "Perdida";
    case "fallida":
      return `No se pudo llamar${call.failureReason ? `: ${call.failureReason}` : "."}`;
    default:
      return "";
  }
}

/**
 * La grabación de una llamada, dicha a la asesora cuando no hay reproductor.
 * Null si no hay nada que decir (una llamada sin conversación no se graba).
 */
export function anuraRecordingNote(status: AnuraRecordingStatus, hasUrl: boolean, answered: boolean): string | null {
  if (status === "guardada") return hasUrl ? null : "Grabación no disponible.";
  if (status === "pendiente") return "Guardando la grabación…";
  if (status === "vencida") return "Grabación vencida: Anura la borra a los 30 minutos y no se pudo copiar a tiempo.";
  return answered ? "Sin grabación: Anura no grabó esta llamada." : null;
}

/**
 * La llamada de `anura_calls` de una entrada `anura_call` del historial. El
 * hecho se escribe con `occurred_at = ended_at` de la llamada
 * (`recordAnuraOrderFact`): se empareja por esa hora, y si nada coincide
 * exacto, con la más cercana dentro de 5 segundos.
 */
export function anuraCallForEntry<T extends { endedAt: string | null }>(occurredAt: string, calls: readonly T[]): T | null {
  const at = Date.parse(occurredAt);
  if (!Number.isFinite(at)) return null;
  let best: T | null = null;
  let bestDiff = Infinity;
  for (const c of calls) {
    if (!c.endedAt) continue;
    const diff = Math.abs(Date.parse(c.endedAt) - at);
    if (Number.isFinite(diff) && diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  }
  return bestDiff <= 5_000 ? best : null;
}

/**
 * Qué ofrece el aviso de la ficha cuando la llamada terminó:
 *   · `inHistory`: dice «Queda en el historial del pedido» y lleva a la mesa de
 *     confirmación. Solo si la llamada dejó su hecho (`call.inHistory`, que
 *     incluye un fin con fallo de Anura) y es de ESTE pedido.
 *   · `otherOrderId`: la llamada es de otro pedido (la ficha retoma la llamada
 *     viva de quien mira aunque sea de otro): se dice y se enlaza a ese.
 */
export function anuraEndedFollowUp(
  call: { mode: string; orderId: string | null; inHistory: boolean },
  orderId: string,
): { inHistory: boolean; otherOrderId: string | null } {
  if (call.mode !== "pedido") return { inHistory: false, otherOrderId: null };
  if (call.orderId && call.orderId !== orderId) return { inHistory: false, otherOrderId: call.orderId };
  return { inHistory: call.inHistory, otherOrderId: null };
}

/**
 * Los pasos en el panel de Anura. Los mismos, en el mismo orden y con las
 * mismas palabras, que MOM §8.7 «Configuración (una vez)» (lo comprueba
 * `test/anura-mom.test.ts`). Lo que va entre comillas invertidas se muestra
 * como código.
 */
export const ANURA_PANEL_STEPS: readonly { title: string; text: string }[] = [
  { title: "Configuración → Cuentas:", text: "un anexo de usuario por asesora." },
  {
    title: "Integraciones → Click 2 Dial → Generar token:",
    text: "el token va en Vercel como `ANURA_CLICK2DIAL_TOKEN`, nunca en un chat ni en Kapta. Sin él no aparece nada de Anura; Kapta solo dice si está configurado, nunca el valor.",
  },
  {
    title: "En cada anexo, Terminales:",
    text: "encender el interruptor de la terminal `<anexo>-websocket` (en el anexo 101, `101-websocket`): así queda como principal y es el teléfono dentro de Kapta; con eso ya no se instala la app ni un softphone de Anura. Hazlo cuando guardes la clave de ese anexo en Kapta: mientras un anexo no tenga clave guardada en Kapta, su principal tiene que ser un teléfono que la asesora contesta (la app de Anura o un teléfono físico), porque la -websocket sin Kapta conectada no suena y Click2Dial falla. Si no existe, se crea con Agregar (Nombre y Usuario: los dos `<anexo>-websocket`). Click2Dial hace sonar siempre la principal: una terminal extra en el mismo anexo nunca suena.",
  },
  {
    title: "En cada anexo, Terminales → lápiz de la -websocket → «Obtener credenciales»:",
    text: "el usuario SIP (`<anexo>-websocket`), la contraseña SIP y el dominio de la central. Se escriben en Kapta, nunca en un chat. Sirve la contraseña de la -websocket: la que tiene @ es la del teléfono físico y no sirve.",
  },
  {
    title: "En cada anexo, Avanzado → «Click 2 Dial»:",
    text: "Auto answer apagado. La llamada de Click2Dial la contesta Kapta, en el navegador, y solo la que la asesora acaba de pedir.",
  },
  {
    title: "En cada anexo, Límites:",
    text: "celulares permitidos. Si no, las llamadas a celular terminan en CONGESTION («destino restringido»). Qué opción de Límites lo permite lo decide el dueño de la cuenta o Anura.",
  },
  {
    title: "Configuración → Eventos → Agregar:",
    text: "un Nombre (por ejemplo «Kapta») y, en sus pestañas: Petición, `POST`, `HTTPS`, el host de Kapta, puerto `443` y la ruta con el token que da Kapta (sin la barra inicial); Encabezados, tipo JSON y sin autenticación; Cuerpo, la plantilla que da Kapta.",
  },
  {
    title: "En cada anexo, Eventos → Agregar tres veces con esa plantilla:",
    text: "(Cuentas → anexo → Eventos) en «Ejecutar cuando», «Se inicia una llamada» (`START`), «La llamada es atendida» (`TALK`) y «Se finaliza una llamada» (`END`), cada uno con dirección «Entrante/Saliente».",
  },
];

/** Lo que se hace en Kapta después de los pasos del panel de Anura. */
export const ANURA_AFTER_PANEL_STEPS =
  "Después, en Kapta, Ajustes › «Telefonía Anura»: el dominio SIP de la central, el anexo de cada persona con su usuario y contraseña SIP («Probar y guardar») y una «Llamada de prueba».";

/** Sondeos seguidos que pueden fallar (red) antes de dejar de mirar una llamada. */
export const ANURA_MAX_POLL_FAILURES = 6;

/** La bitácora de avisos de Ajustes: qué hizo Kapta con cada uno. */
export const ANURA_EVENT_OUTCOME_LABEL: Record<"aplicado" | "repetido" | "ignorado" | "error", string> = {
  aplicado: "Aplicado",
  repetido: "Repetido",
  ignorado: "Ignorado",
  error: "Error",
};

