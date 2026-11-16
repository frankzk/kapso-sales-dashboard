"use client";

// «Agendar» en la fila y «Mover a…» en lote (owner, 15-11-2026; MOM §9.5):
// elegir el día sin abrir la ficha. El camino lo decide el pedido
// (`agendarPath`, y otra vez el servidor en `agendarReproLima`): con un acuerdo
// con la clienta se cambia su día con el mismo courier; sin acuerdo y sin
// rótulo, «Programar envío»; un no entregado sin acuerdo, un acuerdo sin
// llamada. Desde el 16-11-2026 se elige también el courier («con un botón ya lo
// dejamos programados exactamente para un courier»). «Atender» sigue siendo
// para llamar y registrar la gestión.
import { useRef, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { Banner, FIELD_BOX, OpsButton, choiceChipClass } from "@/components/ops-ui";
import { Sheet } from "@/components/filter-sheet";
import { agendarReproLima, type AgendarResult } from "@/app/dashboard/pedidos/repro-lima/agenda-actions";
import { PROGRAM_COURIER_HINT, agendaDayLabel, agendarMaxDay, agendarQuickDays, programCourierChoices, programarConfirmLabel, programarVerb, type AgendarPath } from "@/lib/repro-lima-blocks";
import { DISPATCH_COURIER_LABEL, type DispatchCourier } from "@/lib/dispatch-date";
import { programDayLabel } from "@/lib/dispatch-day";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";

export type AgendarChannel = "llamada" | "whatsapp";
export type AgendarFeedback = {
  kind: "notice" | "error";
  text: string;
  /** GF Courier no anuló o no creó la guía del día nuevo: abrir la Mesa de ruta de este pedido. */
  mesa?: { orderId: string; orderName: string } | null;
};

/** Un id por pedido y envío. `crypto.randomUUID` solo existe en contexto seguro: si falta, uno v4 a mano. */
export function newAgendarOperationId(): string {
  const c = typeof crypto !== "undefined" ? crypto : null;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * El resultado de una acción, dicho para el aviso. Guardado con un error después
 * (no se programó, o GF Courier no creó la guía) es un error; si la acción
 * enlaza a la Mesa de ruta (`href`), el aviso la ofrece para ese pedido.
 */
export function agendarOutcome(orderName: string, result: AgendarResult, orderId?: string): { saved: boolean; feedback: AgendarFeedback } {
  const mesa = result.href && orderId ? { orderId, orderName } : null;
  if (result.notice) {
    return {
      saved: true,
      feedback: result.error
        ? { kind: "error", text: `${orderName}: ${result.error}`, mesa }
        : { kind: "notice", text: `${orderName}: ${result.notice}`, mesa },
    };
  }
  return { saved: false, feedback: { kind: "error", text: result.error ?? "No se pudo agendar. Vuelve a intentarlo.", mesa } };
}

/** Los próximos días por su nombre y, aparte, cualquier otro día hasta `maxDay`. */
export function DayPicker({ today, maxDay, value, onChange, label = "Día" }: {
  today: string;
  maxDay: string;
  value: string;
  onChange: (day: string) => void;
  label?: string;
}) {
  const quick = agendarQuickDays(today);
  return (
    <div className="space-y-2">
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {quick.map((day) => (
          <button key={day} type="button" aria-pressed={value === day} onClick={() => onChange(day)} className={choiceChipClass(value === day)} title={programDayLabel(day)}>
            {day === today ? "Hoy" : agendaDayLabel(day)}
          </button>
        ))}
      </div>
      <label className="grid gap-1 text-xs font-medium text-ink-600">
        Otro día
        <input
          type="date"
          min={today}
          max={maxDay}
          value={quick.includes(value) ? "" : value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(FIELD_BOX, "h-9 w-44 px-3 pointer-coarse:h-11")}
        />
      </label>
    </div>
  );
}

/** Un acuerdo es con la clienta: por dónde se habló. */
export function ChannelPicker({ value, onChange }: { value: AgendarChannel; onChange: (channel: AgendarChannel) => void }) {
  return (
    <div role="group" aria-label="¿Cómo lo acordaste?" className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs font-medium text-ink-600">¿Cómo lo acordaste?</span>
      {(["llamada", "whatsapp"] as const).map((c) => (
        <button key={c} type="button" aria-pressed={value === c} onClick={() => onChange(c)} className={choiceChipClass(value === c)}>
          {c === "llamada" ? "Llamada" : "WhatsApp"}
        </button>
      ))}
    </div>
  );
}

/**
 * Con qué courier sale (owner, 16-11-2026). `optional`: «Sin elegir» deja el
 * envío como antes (la ruta la decide quien crea la guía). Debajo, qué pasa con
 * el elegido: GF Courier crea la guía para ese día; Aliclik y Swayp quedan
 * programados.
 */
export function CourierPicker({ value, onChange, choices, optional = false }: {
  value: DispatchCourier | null;
  onChange: (courier: DispatchCourier | null) => void;
  choices: readonly DispatchCourier[];
  optional?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div role="group" aria-label="Sale con" className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-ink-600">Sale con</span>
        {optional && (
          <button type="button" aria-pressed={value === null} onClick={() => onChange(null)} className={cn(choiceChipClass(value === null), "pointer-coarse:h-11")}>
            Sin elegir
          </button>
        )}
        {choices.map((c) => (
          <button key={c} type="button" aria-pressed={value === c} onClick={() => onChange(c)} className={cn(choiceChipClass(value === c), "pointer-coarse:h-11")}>
            {DISPATCH_COURIER_LABEL[c]}
          </button>
        ))}
      </div>
      <p className="text-xs leading-5 text-ink-500">
        {value ? PROGRAM_COURIER_HINT[value] : optional ? "Sin courier: la ruta la decide quien crea la guía." : "Elige con qué courier sale."}
      </p>
    </div>
  );
}

/**
 * «Programar» / «Reprogramar» de una fila (antes «Agendar»; owner, 16-11-2026):
 * un popover con el día, el courier (sin acuerdo) y, con un acuerdo, por dónde
 * se habló.
 */
export function AgendarButton({ row, path, today, onDone, size = "sm", suggested, hasDay, gfCourierApi = false, currentCourier = null }: {
  row: Pick<LimaPendingOrder, "orderId" | "orderName">;
  path: Exclude<AgendarPath, { kind: null }>;
  today: string;
  onDone: (feedback: AgendarFeedback) => void;
  size?: "sm" | "md";
  /** Sin día, el que propone Kapta (`limaSuggestedDay`): llega elegido y se confirma con un toque. */
  suggested?: string;
  /** Ya tiene día (`agendaDay`): «Reprogramar»; si no, «Programar». */
  hasDay?: boolean;
  /** Su tienda tiene GF Courier por API: se ofrece GF Courier en vez de Grupo GF. */
  gfCourierApi?: boolean;
  /** El courier con que ya está programado el envío (0348), si tiene uno. */
  currentCourier?: DispatchCourier | null;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const initial = path.current && path.current >= today ? path.current : suggested ?? "";
  const [day, setDay] = useState(initial);
  const [channel, setChannel] = useState<AgendarChannel>("llamada");
  const choices = programCourierChoices(gfCourierApi);
  // Un no entregado sin acuerdo necesita courier: llega el de la tienda (GF Courier con la API, si no Grupo GF), como «Atender».
  const [courier, setCourier] = useState<DispatchCourier | null>(path.kind === "acuerdo_nuevo" ? choices[0] ?? null : currentCourier);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const maxDay = agendarMaxDay(today, path.maxDays);
  const unchanged = Boolean(path.current) && day === path.current && courier === currentCourier;
  const needsCourier = path.kind === "acuerdo_nuevo" && !courier;
  const dated = hasDay ?? Boolean(path.current);
  const verb = programarVerb(dated);

  function save() {
    if (!day || pending) return;
    setError(null);
    start(async () => {
      const result = await agendarReproLima({
        orderId: row.orderId,
        day,
        channel: path.kind === "acuerdo" ? channel : null,
        note: path.kind === "envio" ? note.trim() || null : null,
        courier: path.kind === "acuerdo" ? null : courier,
        operationId: newAgendarOperationId(),
      }).catch((e: unknown): AgendarResult => ({ error: e instanceof Error ? e.message : String(e) }));
      const outcome = agendarOutcome(row.orderName, result, row.orderId);
      if (!outcome.saved) {
        setError(outcome.feedback.text);
        return;
      }
      setOpen(false);
      onDone(outcome.feedback);
    });
  }

  return (
    <>
      <OpsButton ref={anchor} size={size} aria-expanded={open} onClick={() => { setError(null); setOpen((v) => !v); }} className="pointer-coarse:h-11">
        {verb}
      </OpsButton>
      {open && (
        <Sheet look="ops" title={`${verb} ${row.orderName}`} onClose={() => setOpen(false)} anchored anchorRef={anchor}>
          <div className="space-y-3">
            <p className="text-[13px] leading-5 text-ink-500">
              {path.kind === "acuerdo"
                ? `Otro día para lo que acordaste con la clienta: sale con ${path.courierName}, acordado para el ${programDayLabel(path.current)}. Kapta revisa qué hacer con la caja y lo programa como en «Atender».`
                : path.kind === "acuerdo_nuevo"
                  ? "Sin llamada: queda acordado para ese día con el courier que elijas, como «Confirma fecha». Kapta revisa qué hacer con la caja."
                  : path.current
                  ? `«Programar envío»: el día en que sale. Hoy está para el ${programDayLabel(path.current)}.`
                  : "«Programar envío»: el día en que sale su primera guía. Se cambia o se quita desde la ficha."}
            </p>
            <DayPicker today={today} maxDay={maxDay} value={day} onChange={setDay} />
            {path.kind === "acuerdo" && <ChannelPicker value={channel} onChange={setChannel} />}
            {path.kind !== "acuerdo" && <CourierPicker value={courier} onChange={setCourier} choices={choices} optional={path.kind === "envio"} />}
            {path.kind === "envio" && (
              <label className="grid gap-1 text-xs font-medium text-ink-600">
                Nota (opcional)
                <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="La clienta recibe en su trabajo el lunes" className={cn(FIELD_BOX, "h-9 w-full px-3 pointer-coarse:h-11")} />
              </label>
            )}
            {error && <Banner tone="crit" role="alert">{error}</Banner>}
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
              <OpsButton variant="ghost" size="sm" onClick={() => setOpen(false)} className="pointer-coarse:h-11">Cancelar</OpsButton>
              <OpsButton variant="primary" size="sm" disabled={!day || unchanged || needsCourier || pending} onClick={save} className="pointer-coarse:h-11">
                {pending ? "Guardando…" : !day ? "Elige el día" : needsCourier ? "Elige el courier" : programarConfirmLabel(dated, day)}
              </OpsButton>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
