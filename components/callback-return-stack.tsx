// La pila de avisos «Tu cliente respondió» (0351), sin lecturas: la usa
// `components/callback-return-alerts.tsx`, que lee y lleva el reloj.

import type { CallbackReturn } from "@/lib/callback-returns";
import { RETURN_HOLD_MINUTES } from "@/lib/lead-appointment-hold";

const WINDOW_MS = RETURN_HOLD_MINUTES * 60_000;
const MAX_VISIBLE = 3;

export const keyOf = (item: CallbackReturn) => `${item.id}:${item.repliedAt}`;

const clock = new Intl.DateTimeFormat("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Lima" });
const dayClock = new Intl.DateTimeFormat("es-PE", {
  weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Lima",
});
const limaDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" });

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function ago(ms: number): string {
  const min = Math.floor(ms / 60_000);
  return min < 1 ? "hace un momento" : min === 1 ? "hace 1 min" : `hace ${min} min`;
}

/** «hoy, 10:00» o «dom 16, 10:00» para la hora agendada. */
function scheduled(iso: string, nowMs: number): string {
  const at = new Date(iso);
  return limaDay.format(at) === limaDay.format(new Date(nowMs)) ? `hoy, ${clock.format(at)}` : dayClock.format(at).replace(".", "");
}

function who(item: CallbackReturn): string {
  if (item.name) return item.name;
  const digits = (item.phone ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "Tu cliente";
}

export function CallbackReturnStack({
  items: live,
  now,
  onOpen: open,
  onDismiss: dismiss,
}: {
  items: CallbackReturn[];
  now: number;
  onOpen: (item: CallbackReturn) => void;
  onDismiss: (item: CallbackReturn) => void;
}) {
  if (!live.length) return null;
  const shown = live.slice(0, MAX_VISIBLE);
  const extra = live.length - shown.length;

  return (
    <section
      aria-label="Clientes que respondieron"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col gap-3 sm:inset-x-auto sm:bottom-auto sm:right-5 sm:top-5 sm:w-[23.5rem]"
    >
      {shown.map((item, index) => {
        const left = Date.parse(item.reservedUntil) - now;
        const share = Math.max(0, Math.min(1, left / WINDOW_MS));
        const headingId = `callback-return-${item.id}`;
        return (
          <article
            key={keyOf(item)}
            aria-labelledby={headingId}
            // En el teléfono, uno solo: los demás se cuentan abajo.
            className={`pointer-events-auto animate-toast-in overflow-hidden rounded-lg bg-white shadow-pop${index > 0 ? " max-sm:hidden" : ""}`}
          >
            {item.reserved && (
              <div className="h-[3px] bg-brand-50" aria-hidden="true">
                <div
                  className="h-full origin-left bg-brand-600 transition-transform duration-1000 ease-linear motion-reduce:transition-none"
                  style={{ transform: `scaleX(${share})` }}
                />
              </div>
            )}
            <div className="p-4">
              <div className="flex items-start gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600" aria-hidden="true">
                  <svg viewBox="0 0 20 20" fill="none" className="size-[18px]">
                    <path
                      d="M5.6 2.75h-1.4a1.5 1.5 0 0 0-1.5 1.6c.4 6.6 5.3 11.5 11.9 11.9a1.5 1.5 0 0 0 1.6-1.5v-1.4a1.5 1.5 0 0 0-1.1-1.4l-2-.6a1.5 1.5 0 0 0-1.5.4l-.7.7a9.4 9.4 0 0 1-4-4l.7-.7a1.5 1.5 0 0 0 .4-1.5l-.6-2a1.5 1.5 0 0 0-1.4-1.1Z"
                      stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"
                    />
                    <path d="M12.25 2.75v4.5h4.5M12.6 6.9l4.65-4.65" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div className="min-w-0 flex-1">
                  <h2 id={headingId} className="text-[15px] font-semibold leading-5 text-ink-900">
                    Tu cliente respondió
                  </h2>
                  <p className="mt-0.5 text-sm leading-5 text-ink-600">
                    <span className="font-medium text-ink-900">{who(item)}</span> te escribió por WhatsApp{" "}
                    <span className="whitespace-nowrap">{ago(now - Date.parse(item.repliedAt))}</span>.
                  </p>
                </div>
              </div>

              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg bg-wash px-3 py-2.5 text-[13px] leading-5">
                <dt className="text-ink-500">Agendaste</dt>
                <dd className="min-w-0 truncate text-ink-900">Volver a llamar · {scheduled(item.followupAt, now)}</dd>
                {item.reserved ? (
                  <>
                    <dt className="text-ink-500">Solo para ti</dt>
                    <dd className="text-ink-900">
                      <span className="font-semibold tabular-nums">{countdown(left)}</span>
                      <span className="text-ink-500"> · hasta las {clock.format(new Date(item.reservedUntil))}</span>
                    </dd>
                  </>
                ) : (
                  <>
                    <dt className="text-ink-500">Reparto</dt>
                    <dd className="text-ink-900">Apagado: otra asesora también puede tomarlo</dd>
                  </>
                )}
              </dl>

              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => dismiss(item)}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-ink-600 transition-colors hover:bg-wash hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1"
                >
                  Más tarde
                </button>
                <button
                  type="button"
                  onClick={() => open(item)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-primary transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
                >
                  Abrir lead
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3.5">
                    <path d="M3.5 8h9m-3.5-3.5L12.5 8 9 11.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
          </article>
        );
      })}
      <MoreReplies count={extra} className="max-sm:hidden" />
      <MoreReplies count={live.length - 1} className="sm:hidden" />
    </section>
  );
}

function MoreReplies({ count, className }: { count: number; className: string }) {
  if (count <= 0) return null;
  return (
    <p className={`pointer-events-auto self-end rounded-full bg-white px-3 py-1 text-xs font-medium text-ink-600 shadow-pop ${className}`}>
      +{count} {count === 1 ? "cliente más respondió" : "clientes más respondieron"}
    </p>
  );
}
