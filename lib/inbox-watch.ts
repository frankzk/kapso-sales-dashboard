// Vigía del buzón (owner, 14-11-2026: «si, agrégalo»).
//
// EL HUECO. Los reportes de movimientos de Yape (§16.2) y los rótulos de Olva
// llegan por correo: un escenario de Make lee el buzón de Outlook y se los pasa
// a Kapta. El 12-11-2026 la conexión de Make con Outlook empezó a fallar (502,
// 503, 504) y Make fue espaciando los reintentos hasta uno por día. Nadie se
// enteró: Kapta no tuvo un reporte de Yape del 09-11 al 13-11, y cualquier Yape
// de esos días se validó a mano o esperó. Make no avisa de esas fallas.
//
// LA REGLA. Tres veces al día (8:23, 13:23 y 18:23 de Lima, `vercel.json`), si
// lo último que llegó de una fuente es más viejo que su umbral, se avisa por el
// Telegram de las tiendas, una vez por chat. Sigue avisando en cada vuelta
// mientras siga callado; nunca de noche.
//
// LOS UMBRALES salen de lo que llegó en 40 días:
//   - Yape manda su reporte varias veces al día, pero de noche y en domingo
//     pasan 18–24 horas sin uno. 30 horas ya no es normal.
//   - Olva solo manda rótulos cuando hay despachos: de sábado a lunes pasan
//     hasta 52 horas sin uno. 60 horas ya no es normal.
// Las dos fuentes usan la misma conexión de Outlook, así que, si la conexión se
// cae, Yape avisa primero.
//
// PURA: recibe las fechas ya leídas.

export type InboxSource = "yape" | "olva";

export interface InboxSourceDef {
  label: string;
  staleHours: number;
  scenario: string;
}

export const INBOX_SOURCES: Record<InboxSource, InboxSourceDef> = {
  yape: {
    label: "Reportes de movimientos de Yape",
    staleHours: 30,
    scenario: "Kapta · Estado de cuenta Yape (Outlook → Kapta)",
  },
  olva: {
    label: "Rótulos de Olva",
    staleHours: 60,
    scenario: "Kapta · Rótulos de Olva (Outlook → Kapta)",
  },
};

/** La conexión de Make que leen los dos escenarios, como se llama en Make. */
export const INBOX_CONNECTION = "Outlook monono.pe (rótulos Olva)";

export interface InboxStatus {
  source: InboxSource;
  lastAt: string | null;
  hours: number | null;
  stale: boolean;
}

const HOUR = 3_600_000;

/**
 * Cómo está cada fuente. Sin nada recibido nunca no se avisa: «nunca llegó»
 * es una fuente sin configurar, no una que se calló.
 */
export function inboxStatus(lastAt: Partial<Record<InboxSource, string | null>>, now: Date): InboxStatus[] {
  return (Object.keys(INBOX_SOURCES) as InboxSource[]).map((source) => {
    const at = lastAt[source] ?? null;
    const t = at ? Date.parse(at) : NaN;
    if (!Number.isFinite(t)) return { source, lastAt: null, hours: null, stale: false };
    const hours = Math.max(0, (now.getTime() - t) / HOUR);
    return { source, lastAt: new Date(t).toISOString(), hours, stale: hours >= INBOX_SOURCES[source].staleHours };
  });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** «jue 12, 12:39» en hora de Lima. */
export function limaShort(iso: string): string {
  const parts = new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    weekday: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday").replace(".", "")} ${get("day")}, ${get("hour")}:${get("minute")}`;
}

/** El aviso de Telegram, o null si ninguna fuente está callada. */
export function formatInboxAlert(statuses: readonly InboxStatus[]): string | null {
  const stale = statuses.filter((s) => s.stale && s.lastAt && s.hours != null);
  if (!stale.length) return null;
  const lines = ["⚠️ <b>Kapta no está recibiendo correos del buzón</b>", ""];
  for (const s of stale) {
    lines.push(`• ${esc(INBOX_SOURCES[s.source].label)}: el último llegó hace ${Math.floor(s.hours!)} h (${esc(limaShort(s.lastAt!))}).`);
  }
  lines.push("");
  lines.push(
    `Revisa en Make: Connections → «${esc(INBOX_CONNECTION)}» → Reauthorize. Después, «Run once» en ${stale
      .map((s) => `«${esc(INBOX_SOURCES[s.source].scenario)}»`)
      .join(" y ")}.`,
  );
  if (stale.some((s) => s.source === "yape")) {
    lines.push("Mientras tanto, los Yapes no se validan solos: quedan en «Pendiente de revisión».");
  }
  return lines.join("\n");
}
