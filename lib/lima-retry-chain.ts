// La cadena de reintentos por Aliclik en Lima (MOM §9.5, «Reintentos Aliclik»,
// 03-11-2026, decisión del owner; entrega 1).
//
// POR QUÉ. De 670 pedidos de Lima que Grupo GF no entregó por «no contesta»,
// «no estaba» u «otro» entre septiembre y octubre, solo 194 volvieron a salir;
// los que salieron se entregaron en 37–50 %. El segundo intento era lo que
// faltaba, no otro courier.
//
// LA REGLA. Un no entregado de Lima con un motivo de la cadena vuelve a salir
// por Aliclik, hasta tres intentos:
//
//   Alexis (Grupo GF) o Urpi → AUTOECOM → ALIDRIVER
//   AUTOECOM → ALIDRIVER
//
// Entran «no contesta», «no estaba» y «otro». No entran el rechazo en puerta, el
// reprogramado (tienen su flujo), la dirección errada ni «sin dinero» (necesitan
// a alguien antes de volver a salir). Los demás motorizados de Grupo GF, Swayp,
// Axel y ALIDRIVER como primer intento no abren cadena. Se corta al tercer
// fallo, a los 7 días del primero, si el pedido se anula o si la tienda acuerda
// otra cosa en Repro Lima: en todos esos casos sigue Repro Lima como siempre.
//
// En la entrega 1 Kapta propone el siguiente intento y lo muestra en Repro Lima
// («Reintentos Aliclik»); la guía la crea una persona desde la ficha.
//
// Pura: sin base ni red. La alimenta `loadReproFacts` (lib/repro-lima-program.ts).

/** Los motivos con los que el pedido sigue por la cadena. */
export const CHAIN_REASONS = ["no_contesta", "no_estaba", "otro"] as const;
export type ChainReason = (typeof CHAIN_REASONS)[number];

/** Cuántos días desde el primer intento sigue abierta la cadena. */
export const CHAIN_MAX_DAYS = 7;

/** El rider de Grupo GF cuyas rutas abren la cadena (owner, 03-11-2026). */
export const CHAIN_GF_RIDER = "Alexis";

export type ChainCarrier = "alexis" | "urpi" | "autoecom" | "alidriver" | "otro";

export const CHAIN_CARRIER_LABEL: Record<ChainCarrier, string> = {
  alexis: "Alexis (Grupo GF)",
  urpi: "Urpi",
  autoecom: "Aliclik AUTOECOM",
  alidriver: "Aliclik ALIDRIVER",
  otro: "otro courier",
};

/** Un intento fallido, del más viejo al más nuevo da igual: se ordena aquí. */
export interface ChainAttempt {
  carrier: ChainCarrier;
  /** El motivo en el vocabulario de la parada (`NON_DELIVERY_REASONS`). */
  reason: string | null;
  /** ISO: cuándo salió el intento (día de la ruta o despacho de la guía). */
  at: string;
}

export type ChainNext = "autoecom" | "alidriver";

export type LimaRetryChain =
  | {
      state: "siguiente";
      /** El intento que toca: 2 o 3. */
      attempt: number;
      /** De cuántos es la cadena: 3 si empezó con Alexis o Urpi, 2 si con AUTOECOM. */
      of: number;
      next: ChainNext;
      failed: ChainAttempt;
      /** El primer intento de la cadena. */
      startedAt: string;
    }
  | { state: "fuera"; why: "sin_cadena" | "motivo" | "agotada" | "vencida" | "descartada"; failed: ChainAttempt | null };

/** Los hechos del historial que deja la bandeja (entrega 2, 03-11-2026). */
export const CHAIN_EVENT_KINDS = {
  /** «Aprobar»: se creó la guía de Aliclik del reintento. */
  approved: "lima_retry_approved",
  /** «A Repro Lima»: alguien lo sacó de la cadena, con motivo. */
  dismissed: "lima_retry_dismissed",
} as const;

/**
 * La cadena, salvo que alguien la haya sacado («A Repro Lima») después del
 * último fallo: entonces sigue Repro Lima. Un fallo nuevo vuelve a abrirla. Pura.
 */
export function withDismissal(chain: LimaRetryChain, dismissedAt: string | null | undefined): LimaRetryChain {
  if (chain.state !== "siguiente" || !dismissedAt) return chain;
  return Date.parse(dismissedAt) >= Date.parse(chain.failed.at) ? { state: "fuera", why: "descartada", failed: chain.failed } : chain;
}

function isChainReason(reason: string | null | undefined): reason is ChainReason {
  return (CHAIN_REASONS as readonly string[]).includes(reason ?? "");
}

/** ¿Es un motorizado de Grupo GF que abre la cadena? Solo Alexis. */
export function isChainRider(riderName: string | null | undefined): boolean {
  const name = (riderName ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  return name === CHAIN_GF_RIDER.toLowerCase() || name.startsWith(`${CHAIN_GF_RIDER.toLowerCase()} `);
}

/**
 * El motivo de una guía de Aliclik que no entregó, en el vocabulario de la
 * parada: `REFUSED` es rechazo en puerta, `RESCHEDULED` reprogramado,
 * `NOT_RESPOND` no contestó; lo demás (`CANCEL`, `ANNULLED`, en devolución)
 * no dice por qué y cuenta como «otro». Pura.
 */
export function aliclikChainReason(reportedStatus: string | null | undefined): string {
  const status = (reportedStatus ?? "").split(" · ")[0]?.trim().toUpperCase() ?? "";
  if (status === "REFUSED") return "rechazado";
  if (status === "RESCHEDULED") return "reprogramado";
  if (status === "NOT_RESPOND") return "no_contesta";
  return "otro";
}

/**
 * El motivo de un no entregado de Urpi. Su reporte trae el resultado y el
 * motivo en texto libre («Motivo principal»): se lee lo que se puede y lo
 * demás cuenta como «otro». Un rechazo dicho con otras palabras queda como
 * «otro»; por eso la bandeja enseña el motivo tal como vino. Pura.
 */
export function urpiChainReason(resultCode: string | null | undefined, reasonText: string | null | undefined): string {
  if (resultCode === "reprogramado") return "reprogramado";
  const text = (reasonText ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (/rechaz|no (lo )?quiere|ya no desea|desist|no acepta/.test(text)) return "rechazado";
  if (/reprogram|otro dia|otra fecha/.test(text)) return "reprogramado";
  if (/direcci|ubicaci|no existe/.test(text)) return "direccion_errada";
  if (/dinero|efectivo|no tiene para pagar/.test(text)) return "sin_dinero";
  if (/no contest|no respond|apagado|no atiende/.test(text)) return "no_contesta";
  if (/no estaba|ausente|no se encontr/.test(text)) return "no_estaba";
  return "otro";
}

/** El carrier de una guía de Aliclik por su transporte. */
export function aliclikCarrier(transportName: string | null | undefined): ChainCarrier {
  const key = (transportName ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (key.includes("AUTOECOM")) return "autoecom";
  if (key.includes("ALIDRIVER")) return "alidriver";
  return "otro";
}

const DAY_MS = 86_400_000;

/**
 * ¿Qué toca con este pedido? Se mira el último intento que falló y, si fue
 * AUTOECOM, el anterior: así se sabe si la cadena es de 3 (Alexis o Urpi →
 * AUTOECOM → ALIDRIVER) o de 2 (AUTOECOM → ALIDRIVER). Pura.
 */
export function limaRetryChain(attempts: readonly ChainAttempt[], now: Date): LimaRetryChain {
  const sorted = [...attempts].filter((a) => Number.isFinite(Date.parse(a.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = sorted.at(-1) ?? null;
  if (!last) return { state: "fuera", why: "sin_cadena", failed: null };
  if (!isChainReason(last.reason)) {
    return { state: "fuera", why: last.carrier === "otro" ? "sin_cadena" : "motivo", failed: last };
  }
  const previous = sorted.length > 1 ? sorted.at(-2)! : null;
  let result: { attempt: number; of: number; next: ChainNext; startedAt: string } | null = null;
  if (last.carrier === "alexis" || last.carrier === "urpi") {
    result = { attempt: 2, of: 3, next: "autoecom", startedAt: last.at };
  } else if (last.carrier === "autoecom") {
    // Viene de Alexis o Urpi, con motivo de la cadena: es el 3 de 3.
    const chained = previous && (previous.carrier === "alexis" || previous.carrier === "urpi") && isChainReason(previous.reason);
    result = chained
      ? { attempt: 3, of: 3, next: "alidriver", startedAt: previous!.at }
      : { attempt: 2, of: 2, next: "alidriver", startedAt: last.at };
  } else if (last.carrier === "alidriver") {
    return { state: "fuera", why: "agotada", failed: last };
  } else {
    return { state: "fuera", why: "sin_cadena", failed: last };
  }
  if (now.getTime() - Date.parse(result.startedAt) > CHAIN_MAX_DAYS * DAY_MS) {
    return { state: "fuera", why: "vencida", failed: last };
  }
  return { state: "siguiente", ...result, failed: last };
}

const REASON_LABEL: Record<string, string> = {
  no_contesta: "no contestó",
  no_estaba: "no estaba",
  otro: "otro motivo",
};

/** El día de Lima (YYYY-MM-DD) de un instante. */
function limaDayOf(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/**
 * ¿Ya se puede aprobar el reintento? Sale OTRO día que el intento que falló, y
 * no espera a que el paquete vuelva a oficina (owner, 03-11-2026: «no necesito
 * esperar la devolución para sacar el pedido, solo que se saque un día
 * distinto»). `today` es el día de Lima. Pura.
 */
export function chainReadyOn(failed: Pick<ChainAttempt, "at">, today: string): boolean {
  const day = limaDayOf(failed.at);
  return day !== null && day < today;
}

/** «Reintento 2 de 3 · AUTOECOM» para la chapa. Pura. */
export function chainChipText(chain: Extract<LimaRetryChain, { state: "siguiente" }>): string {
  return `Reintento Aliclik ${chain.attempt} de ${chain.of} · ${chain.next === "autoecom" ? "AUTOECOM" : "ALIDRIVER"}`;
}

/** «Falló con Alexis (Grupo GF) el 02/11: no contestó». Pura. */
export function chainFailureText(failed: ChainAttempt): string {
  const day = failed.at.slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}` : "";
  return `Falló con ${CHAIN_CARRIER_LABEL[failed.carrier]}${date ? ` el ${date}` : ""}: ${REASON_LABEL[failed.reason ?? ""] ?? failed.reason ?? "sin motivo"}`;
}
