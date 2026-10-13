"use client";

// «Repro Lima» · la hoja de un pedido (fase 1, entrega 1a; MOM §9.5, §11.4-§11.7).
//
// Quien llama abre la hoja y el caso queda suyo diez minutos (candado de D10,
// el mismo de Envíos): se toma al abrir, late cada cuatro minutos, se suelta
// al cerrar o al desmontar la hoja (atrás del navegador) y, si la pestaña se
// cierra o se recarga, con un beacon; si la página vuelve del bfcache, se
// vuelve a tomar. Con el candado de otra persona, o desde «Cerrados» y «Ver
// acuerdo», la hoja es de solo lectura y no toma nada (E29).
//
// Antes de llamar se lee el fallo (motivo, nota y foto, §11.7), dónde está la
// caja, la fecha que pidió el cliente y las llamadas anteriores. Después se
// elige uno de los cuatro resultados (§11.4). Con «Confirma fecha» Kapta
// calcula qué hacer con la caja y cuándo se programa: la persona declara qué
// cambió, no elige la acción (decisión 8). La fecha se valida igual que en el
// servidor (§11.6) y la hora de la próxima llamada se convierte SIEMPRE con
// `limaDateTimeIso` (E19).
//
// Cada formulario lleva un `operationId` (`crypto.randomUUID()`): un doble
// clic no registra dos llamadas, y si el formulario cambia después de un
// envío, se estrena otro (E3).

import { useCallback, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, CHECKBOX, choiceChipClass, FIELD, OpsButton, OptionTile, SidePanel, Skeleton, opsButtonClass, type BadgeTone } from "@/components/ops-ui";
import { IconPhone, IconWhatsApp } from "@/components/icons";
import { OrderLink, useOpenOrderDrawer } from "@/components/order-link";
import { SwaypDispatchDateSelect } from "@/components/swayp-dispatch-date-select";
import type { ReproRow } from "@/lib/repro-lima-access";
import {
  claimReproCase,
  closeReproCase,
  loadReproCalls,
  loadReproRow,
  programReproAgreement,
  registerReproCall,
  releaseReproCase,
  renewReproCase,
  type RegisterReproCallInput,
  type RegisterReproCallResult,
  type ReproActionResult,
  type ReproCallView,
} from "@/app/dashboard/pedidos/repro-lima/actions";
import { limaClock, nextDay, sameDayCutoffLabel } from "@/lib/grupo-gf-courier";
import { programDayLabel } from "@/lib/dispatch-day";
import { RESCHEDULE_MAX_DAYS } from "@/lib/gf-dispatch-program";
import { DISCARD_REASON_MIN, validarMotivoDescarte } from "@/lib/recovery-discard";
import { soles, telHref, whatsappHref } from "@/lib/rider-contact";
import { MAX_OUTPUTS_PER_ORDER } from "@/lib/shipment-output";
import { boxActionReadyLabel, reproBoxAction, type ReproBoxActionResult } from "@/lib/repro-box-action";
import {
  agreementDateProblem,
  BOX_ACTION_LABEL,
  firstAllowedDay,
  isBoxAction,
  isProblemState,
  isReproCourier,
  isReproOutcome,
  limaDateTimeFromInput,
  limaDateTimeInputValue,
  limaDateTimeIso,
  materializationPlan,
  nextCallProblem,
  nextRoundAt,
  noEsperarCajaAplica,
  normalizeReproChanges,
  reproCallTimeLabel,
  reproChangesText,
  reproCourierDisabledReason,
  reproCourierName,
  REPRO_CLAIM_HEARTBEAT_MS,
  REPRO_COURIER_CHOICES,
  REPRO_COURIER_LABEL,
  REPRO_LIST_LABEL,
  REPRO_OUTCOME_LABEL,
  type AgreementStateKind,
  type BoxLocation,
  type MaterializationPlan,
  type ReproChanges,
  type ReproChipKey,
  type ReproCourier,
  type ReproOutcome,
} from "@/lib/repro-lima";

// ---------------------------------------------------------------------------
// Piezas que comparte el tablero (components/repro-lima-board.tsx)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

/** «987 654 321»: el celular peruano en tres grupos; lo demás tal cual. */
export function phoneLabel(phone: string | null | undefined): string | null {
  const raw = (phone ?? "").trim();
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("51")) digits = digits.slice(2);
  if (digits.length === 9) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return raw;
}

/** La hora de Lima de un instante («10:42»). */
export function limaHour(iso: string | null | undefined): string | null {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  return hhmm(limaClock(new Date(t)).minute);
}

/** «hoy 16:20» u «11/10 16:20», en hora de Lima. */
export function limaStamp(iso: string | null | undefined, today: string): string | null {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return null;
  const at = limaClock(new Date(t));
  const time = hhmm(at.minute);
  return at.day === today ? `hoy ${time}` : `${at.day.slice(8, 10)}/${at.day.slice(5, 7)} ${time}`;
}

/** «6 d en la etapa». */
export function stageAgeLabel(days: number | null): string | null {
  if (days == null) return null;
  return days === 0 ? "entró hoy a la etapa" : `${days} d en la etapa`;
}

/** «Salidas 2 de 5 · KP138029-S02 Grupo GF». */
export function outputsLine(row: ReproRow): string {
  const last = row.lastOutput ? [row.lastOutput.code, row.lastOutput.courierName].filter(Boolean).join(" ") : "";
  return `Salidas ${row.outputsUsed} de ${MAX_OUTPUTS_PER_ORDER}${last ? ` · ${last}` : ""}`;
}

/** La foto de la parada: la sirve /api/reparto/foto con RLS de la parada. */
export function photoHref(path: string): string {
  return `/api/reparto/foto?path=${encodeURIComponent(path)}`;
}

/** El fallo en una línea (§11.7); en `crit-fg` si lo rechazó en la puerta. */
export function FailureLine({ row, className }: { row: ReproRow; className?: string }) {
  if (!row.failure) {
    return <p className={cn("text-[13px] leading-5 text-ink-500", className)}>Sin «No entregado» registrado: revisa la ficha.</p>;
  }
  return (
    <p className={cn("text-[13px] leading-5", row.failure.rejected ? "text-crit-fg" : "text-ink-700", className)}>
      {row.failure.text}
      {row.failure.photoPath && (
        <>
          {" · "}
          <a href={photoHref(row.failure.photoPath)} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
            Foto
          </a>
        </>
      )}
    </p>
  );
}

/** «Lo atiendes tú» o «Diana lo atiende». Libre no dice nada. */
export function ClaimBadge({ row }: { row: ReproRow }) {
  if (row.claim.view === "mio") return <Badge tone="ok">Lo atiendes tú</Badge>;
  if (row.claim.view === "otro") return <Badge tone="warn">{`${row.claim.byName ?? "Otra persona"} lo atiende`}</Badge>;
  return null;
}

function boxTone(box: BoxLocation): BadgeTone {
  switch (box.kind) {
    case "con_motorizado":
      return box.sinReporte ? "warn" : "info";
    case "en_oficina":
      return "neutral";
    case "volviendo_courier":
      return "info";
    case "desconocida":
      return "warn";
  }
}

function stateTone(kind: AgreementStateKind): BadgeTone {
  if (kind === "programado") return "ok";
  if (kind === "esperando_caja") return "info";
  if (kind === "sin_acuerdo") return "neutral";
  return isProblemState(kind) ? "warn" : "neutral";
}

const CHIP_TONE: Record<ReproChipKey, BadgeTone> = {
  toca_llamar: "info",
  acuerdo_anterior: "neutral",
  acuerdo_vencido: "warn",
  programado_gf_sin_acuerdo: "info",
  programado_acuerdo_anterior: "warn",
  fecha_motorizado: "warn",
  pidio: "info",
};

/**
 * Las chapas de la fila (D13): el acuerdo y su estado, la caja, lo que dice la
 * lista (llamada que toca, fecha pedida, programa sin acuerdo), las llamadas
 * sin respuesta y la sugerencia de cerrar. Siempre con texto (§ Estados).
 */
export function ReproRowChips({ row, today }: { row: ReproRow; today: string }) {
  const chips: Array<{ key: string; tone: BadgeTone; text: string }> = [];
  if (row.list === "cerrados" && row.closed) {
    const day = limaStamp(row.closed.at, today);
    chips.push({ key: "cerrado", tone: "neutral", text: `Desarmar y cerrar${row.closed.byName ? ` · ${row.closed.byName}` : ""}${day ? ` · ${day}` : ""}` });
    chips.push({ key: "anula", tone: "neutral", text: "Espera que Shopify anule la venta" });
  }
  if (row.agreement && row.state.kind !== "sin_acuerdo") {
    chips.push({ key: "estado", tone: stateTone(row.state.kind), text: row.stateLabel });
  }
  chips.push({ key: "caja", tone: boxTone(row.box), text: row.boxLabel });
  for (const chip of row.chips) {
    const tone = chip.key === "toca_llamar"
      ? (row.overdue ? "warn" : "info")
      : chip.key === "pidio" && chip.text.includes("ya pasó")
        ? "neutral"
        : CHIP_TONE[chip.key];
    chips.push({ key: `lista-${chip.key}`, tone, text: chip.text });
  }
  if (row.noAnswerCount > 0 || row.lastCall) {
    const when = row.lastCall ? limaStamp(row.lastCall.at, today) : null;
    const last = when ? `última ${when}${row.lastCall?.byName ? `, ${row.lastCall.byName}` : ""}` : null;
    const text = row.noAnswerCount > 0
      ? [`${row.noAnswerCount} sin respuesta`, last].filter(Boolean).join(" · ")
      : `Llamada ${last ?? ""}`.trim();
    chips.push({ key: "llamadas", tone: "neutral", text });
  }
  if (row.reopened) chips.push({ key: "reabierto", tone: "neutral", text: "Reabierto después de «Desarmar y cerrar»" });
  if (row.dismantleSuggested) chips.push({ key: "sugerido", tone: "warn", text: "Sugerido: desarmar y cerrar" });
  return (
    <>
      {chips.map((chip) => (
        <Badge key={chip.key} tone={chip.tone} wrap>
          {chip.text}
        </Badge>
      ))}
    </>
  );
}

/** «Llamar 987 654 321» con `tel:`; sin número, nada. */
export function CallButton({ phone, size = "md", className }: { phone: string | null; size?: "sm" | "md" | "lg"; className?: string }) {
  const href = telHref(phone);
  const label = phoneLabel(phone);
  if (!href || !label) return null;
  return (
    <a href={href} className={opsButtonClass("secondary", size, cn("pointer-coarse:h-11", className))}>
      <IconPhone aria-hidden />
      Llamar {label}
    </a>
  );
}

// ---------------------------------------------------------------------------
// La hoja
// ---------------------------------------------------------------------------

/** Lo que el tablero recibe al guardar: el aviso y la ficha si hay que crear la salida (D7). */
export interface ReproSaved {
  orderId: string;
  orderName: string;
  notice: string | null;
  error: string | null;
  /** Otro courier: la salida se crea desde la Mesa de ruta de la ficha. */
  mesa: boolean;
}

type ClaimState = "idle" | "claiming" | "mine" | "held" | "lost" | "reopen" | "error";
type NextCallKind = "1h" | "hoy" | "manana" | "otra" | "ninguna";
type NextCall = { kind: NextCallKind | null; iso: string | null; input: string };

const NO_NEXT_CALL: NextCall = { kind: null, iso: null, input: "" };

const CHANGE_FIELDS: Array<{ key: Exclude<keyof ReproChanges, "no_esperar_caja">; label: string }> = [
  { key: "direccion", label: "Dirección o referencia" },
  { key: "telefono", label: "Teléfono" },
  { key: "monto", label: "Monto" },
  { key: "producto", label: "Producto, talla, color o cantidad" },
  { key: "caja_danada", label: "Caja abierta o dañada" },
];

const OUTCOME_HELP: Record<ReproOutcome, string> = {
  confirma: "Fecha y courier. Kapta calcula qué hacer con la caja.",
  llamar_despues: "El cliente pidió que lo llames a otra hora.",
  no_contesta: "Suma un intento sin respuesta.",
  no_quiere: "Desarmar y cerrar. No anula la venta.",
};

/** Un id por formulario. `crypto.randomUUID` solo existe en contexto seguro: si falta, uno v4 a mano. */
function newOperationId(): string {
  const c = typeof crypto !== "undefined" ? crypto : null;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** La hora redonda (cada cinco minutos) dentro de `minutes`, como instante de Lima (E19). */
function limaInMinutes(now: Date, minutes: number): string {
  const ms = Math.ceil((now.getTime() + minutes * 60_000) / 300_000) * 300_000;
  const at = limaClock(new Date(ms));
  return limaDateTimeIso(at.day, hhmm(at.minute));
}

/** «Se programa: …» del acuerdo, con el plan que calcula Kapta. */
function planText(plan: MaterializationPlan, courier: ReproCourier, box: BoxLocation): string {
  if (plan === "ahora") return "al guardar, en Grupo GF (sale en «Programados» de Despacho del día).";
  if (plan === "al_recibir") return `al recibir la caja de ${box.kind === "con_motorizado" ? box.riderName : "el motorizado"} en oficina.`;
  switch (plan.no) {
    case "otro_courier":
      return `no en Grupo GF: crea la salida de ${REPRO_COURIER_LABEL[courier]} desde la Mesa de ruta de la ficha.`;
    case "falta_salida":
      return "todavía no: falta la salida nueva (Kapta no la crea con la caja en oficina). Avisa a Despacho GF.";
    case "falta_ubicar":
      return "cuando alguien encuentre la caja en la oficina («Ya la encontré: programar»).";
    case "falta_recibir_devolucion":
      return `cuando la caja de ${box.kind === "volviendo_courier" ? reproCourierName(box.courier) : "su courier"} llegue a Devoluciones.`;
  }
}

function Chip({ label, active, disabled, title, onClick }: { label: string; active: boolean; disabled?: boolean; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={cn(choiceChipClass(active), disabled && "cursor-not-allowed opacity-40")}
    >
      {label}
    </button>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function callLine(call: ReproCallView, today: string, now: Date): { head: string; detail: string | null } {
  const when = limaStamp(call.at, today) ?? "—";
  const what = call.channel === "sin_contacto"
    ? "Desarmar y cerrar sin llamada"
    : `${isReproOutcome(call.outcome) ? REPRO_OUTCOME_LABEL[call.outcome] : call.outcome}${call.channel === "whatsapp" ? " (WhatsApp)" : ""}`;
  const parts: string[] = [];
  if (call.outcome === "confirma" && call.agreedOn) {
    parts.push(`${programDayLabel(call.agreedOn.slice(0, 10))} con ${call.courierName ?? "su courier"}`);
    if (call.boxAction && isBoxAction(call.boxAction)) parts.push(`caja: ${BOX_ACTION_LABEL[call.boxAction].toLocaleLowerCase("es")}`);
  }
  if (call.nextCallAt) parts.push(`próxima ${reproCallTimeLabel(call.nextCallAt, now)}`);
  if (call.note?.trim()) parts.push(`«${call.note.trim()}»`);
  return { head: [when, call.byName ?? "—", what].join(" · "), detail: parts.length ? parts.join(" · ") : null };
}

/** La hora de la próxima llamada: chips de la vuelta y «Otra hora» (`datetime-local` vía `limaDateTimeIso`, E19). */
function NextCallPicker({ now, value, optional, onChange }: {
  now: Date;
  value: NextCall;
  /** «No contesta»: se puede quedar sin próxima llamada. */
  optional: boolean;
  onChange: (value: NextCall) => void;
}) {
  const today = limaClock(now).day;
  const afternoon = limaDateTimeIso(today, "15:00");
  const morning = limaDateTimeIso(nextDay(today), "08:30");
  const afternoonProblem = nextCallProblem(afternoon, now);
  const min = limaDateTimeInputValue(now.toISOString());
  const max = limaDateTimeInputValue(new Date(now.getTime() + RESCHEDULE_MAX_DAYS * DAY_MS).toISOString());
  const problem = value.kind && value.kind !== "ninguna" ? nextCallProblem(value.iso, now) : null;
  return (
    <div className="space-y-2">
      <div role="group" aria-label="Próxima llamada" className="flex flex-wrap gap-1.5">
        <Chip label="En 1 hora" active={value.kind === "1h"} onClick={() => onChange({ kind: "1h", iso: limaInMinutes(new Date(), 60), input: "" })} />
        <Chip
          label="Hoy 15:00"
          active={value.kind === "hoy"}
          disabled={Boolean(afternoonProblem)}
          title={afternoonProblem ? "Las 15:00 ya pasaron." : undefined}
          onClick={() => onChange({ kind: "hoy", iso: afternoon, input: "" })}
        />
        <Chip label="Mañana 08:30" active={value.kind === "manana"} onClick={() => onChange({ kind: "manana", iso: morning, input: "" })} />
        <Chip label="Otra hora" active={value.kind === "otra"} onClick={() => onChange({ kind: "otra", iso: limaDateTimeFromInput(value.input), input: value.input })} />
        {optional && <Chip label="Sin próxima llamada" active={value.kind === "ninguna" || value.kind === null} onClick={() => onChange({ kind: "ninguna", iso: null, input: "" })} />}
      </div>
      {value.kind === "otra" && (
        <label className="block max-w-xs text-[13px] text-ink-600">
          Día y hora (Lima)
          <input
            type="datetime-local"
            value={value.input}
            min={min}
            max={max}
            onChange={(e) => onChange({ kind: "otra", input: e.target.value, iso: limaDateTimeFromInput(e.target.value) })}
            className={cn(FIELD, "mt-1")}
          />
        </label>
      )}
      {value.iso && !problem && <p className="text-[13px] text-ink-600">Próxima llamada: {reproCallTimeLabel(value.iso, now)}.</p>}
      {problem && value.kind !== "otra" && <p className="text-[13px] text-warn-fg">{problem}</p>}
    </div>
  );
}

export function ReproLimaSheet({
  row,
  initialMode,
  askReopen = false,
  hasNext,
  onClose,
  onSaved,
  onChanged,
  previous = null,
}: {
  row: ReproRow;
  /** `edit`: «Atender» (toma el caso). `read`: «Ver acuerdo» y «Cerrados» (E29), sin candado. */
  initialMode: "edit" | "read";
  /** «Volver a atender» desde «Cerrados»: el segundo clic va en la hoja (E29). */
  askReopen?: boolean;
  /** Hay otro pedido en la lista para «Guardar y pasar al siguiente». */
  hasNext: boolean;
  onClose: () => void;
  /** Se guardó la llamada; `advance`: abrir el siguiente. */
  onSaved: (saved: ReproSaved, advance: boolean) => void;
  /** Algo cambió fuera del formulario («Programar ahora»): el tablero relee. */
  onChanged: () => void;
  /**
   * Lo que dijo el guardado del pedido anterior con «Guardar y pasar al
   * siguiente» («Avisa a Almacén…»): va arriba de esta hoja para que no se tape.
   */
  previous?: { orderName: string; text: string } | null;
}) {
  const orderId = row.orderId;
  const openDrawer = useOpenOrderDrawer();
  const [mode, setMode] = useState<"edit" | "read">(initialMode);
  const [showReopen, setShowReopen] = useState(askReopen);
  const [pending, start] = useTransition();

  // El reloj de la hoja: el corte y las vueltas de llamadas cambian con la hora.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const clock = limaClock(now);
  const today = clock.day;

  // Los hechos frescos del pedido y sus llamadas (la caja pudo cambiar).
  const [fresh, setFresh] = useState<ReproRow | null>(null);
  const [gone, setGone] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [calls, setCalls] = useState<ReproCallView[] | null>(null);
  const [allCalls, setAllCalls] = useState(false);
  // El tablero relee al volver a la pestaña: su fila es tan fresca como esta.
  useEffect(() => { setFresh(null); }, [row]);
  const current = fresh ?? row;

  const reload = useCallback(async () => {
    const [rowResult, callResult] = await Promise.all([
      loadReproRow(orderId).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
      loadReproCalls(orderId).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
    ]);
    if ("error" in rowResult) setLoadError(rowResult.error);
    else if (rowResult.row) { setFresh(rowResult.row); setLoadError(null); setGone(false); }
    else setGone(true);
    if ("calls" in callResult) setCalls(callResult.calls);
    else setCalls([]);
  }, [orderId]);

  useEffect(() => {
    if (mode === "read") void reload();
  }, [mode, reload]);

  // -------------------------------------------------------------------------
  // El candado (D10): eager al abrir, latido, beacon en `pagehide`, soltar al cerrar
  // -------------------------------------------------------------------------
  const [claimState, setClaimState] = useState<ClaimState>("idle");
  const [claimMessage, setClaimMessage] = useState<string | null>(null);
  const [claimUntil, setClaimUntil] = useState<string | null>(null);
  const [holder, setHolder] = useState<{ name: string | null; until: string | null } | null>(null);
  const [caseId, setCaseId] = useState<string | null>(row.caseId);
  const [claimAttempt, setClaimAttempt] = useState(0);
  const claimSessionRef = useRef<{ orderId: string; caseId: string | null; shouldRelease: boolean } | null>(null);
  // «Sí, volver a atender» (E29) vale para UNA toma: «Reintentar» y «Volver a
  // tomarlo» toman sin reabrir, así un «Desarmar y cerrar» que otra persona
  // acaba de guardar vuelve a pedir el segundo clic. Se borra al responder la
  // toma, no al empezarla: en desarrollo el efecto corre dos veces.
  const reopenRef = useRef(false);

  useEffect(() => {
    if (mode !== "edit") return;
    let active = true;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const session = { orderId, caseId: null as string | null, shouldRelease: false };
    claimSessionRef.current = session;
    const reopen = reopenRef.current;
    setClaimState("claiming");
    setClaimMessage(null);
    setHolder(null);

    // Si la pestaña se cierra o se recarga con la hoja abierta, el cierre normal
    // nunca corre y el caso quedaba tomado diez minutos. `sendBeacon` sobrevive
    // a la descarga; una acción de servidor, no.
    const onPageHide = () => {
      if (session.shouldRelease || !session.caseId) return;
      session.shouldRelease = true;
      navigator.sendBeacon?.(
        "/api/repro-lima/release-claim",
        new Blob([JSON.stringify({ caseId: session.caseId })], { type: "application/json" }),
      );
    };
    // Si la página vuelve del bfcache (atrás y adelante), el beacon ya soltó
    // el caso y el latido calla: se vuelve a tomar, con lo escrito intacto.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted && session.shouldRelease) setClaimAttempt((n) => n + 1);
    };

    void claimReproCase(orderId, reopen ? { reopen: true } : {})
      .then((result) => {
        reopenRef.current = false;
        if (session.shouldRelease) {
          if (!("error" in result)) void releaseReproCase(result.caseId).catch(() => undefined);
          return;
        }
        if (!active) {
          // La hoja se desmontó con la toma en camino: se suelta. Si el efecto
          // volvió a correr, la toma nueva es otra sesión y esta no suelta nada.
          if (claimSessionRef.current === session && !("error" in result)) void releaseReproCase(result.caseId).catch(() => undefined);
          return;
        }
        if ("error" in result) {
          if (result.needsReopen) {
            setClaimState("reopen");
            setShowReopen(true);
          } else if (result.holder) {
            setClaimState("held");
            setHolder(result.holder);
          } else {
            setClaimState("error");
            setClaimMessage(result.error);
          }
          void reload();
          return;
        }
        session.caseId = result.caseId;
        setCaseId(result.caseId);
        setClaimUntil(result.until);
        setClaimState("mine");
        window.addEventListener("pagehide", onPageHide);
        window.addEventListener("pageshow", onPageShow);
        void reload();
        heartbeat = setInterval(() => {
          void renewReproCase(result.caseId)
            .then((renewal) => {
              if (!active || session.shouldRelease) return;
              if ("error" in renewal) {
                setClaimState("lost");
                setClaimMessage(renewal.error);
                if (heartbeat) clearInterval(heartbeat);
                heartbeat = null;
                return;
              }
              setClaimUntil(renewal.until);
            })
            .catch(() => {
              if (!active || session.shouldRelease) return;
              setClaimState("lost");
              setClaimMessage("No pudimos renovar el caso. Vuelve a tomarlo.");
              if (heartbeat) clearInterval(heartbeat);
              heartbeat = null;
            });
        }, REPRO_CLAIM_HEARTBEAT_MS);
      })
      .catch(() => {
        reopenRef.current = false;
        if (!active || session.shouldRelease) return;
        setClaimState("error");
        setClaimMessage("No pudimos tomar el caso. Cierra y vuelve a intentarlo.");
      });

    return () => {
      active = false;
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      if (heartbeat) clearInterval(heartbeat);
      // Desmontar la hoja sin «Cerrar» ni «Soltar» (atrás del navegador, un
      // enlace de la ficha) también suelta el caso (§9.5). Si el efecto vuelve
      // a correr («Volver a tomarlo»), se suelta antes de la toma nueva: las
      // acciones de servidor corren de a una, en orden.
      if (session.caseId && !session.shouldRelease) {
        session.shouldRelease = true;
        void releaseReproCase(session.caseId).catch(() => undefined);
      }
    };
  }, [orderId, mode, claimAttempt, reload]);

  function releaseCurrentClaim() {
    const session = claimSessionRef.current;
    if (!session || session.shouldRelease) return;
    session.shouldRelease = true;
    if (session.caseId) void releaseReproCase(session.caseId).catch(() => undefined);
  }

  const mine = mode === "edit" && claimState === "mine";

  // -------------------------------------------------------------------------
  // El formulario
  // -------------------------------------------------------------------------
  const [form, setForm] = useState<"call" | "close">("call");
  const [channel, setChannel] = useState<"llamada" | "whatsapp">("llamada");
  const [outcome, setOutcome] = useState<ReproOutcome | null>(null);
  const [courier, setCourier] = useState<ReproCourier | null>(() => {
    const agreed = row.agreement?.courier;
    return agreed && (REPRO_COURIER_CHOICES as readonly string[]).includes(agreed) ? (agreed as ReproCourier) : "propio";
  });
  const [changes, setChanges] = useState<ReproChanges>(() => normalizeReproChanges(row.agreement?.changes ?? null));
  // La fecha nunca se preselecciona: ni la que pidió el cliente ni la del motorizado (D9).
  const [agreedOn, setAgreedOn] = useState("");
  const [otherDate, setOtherDate] = useState(false);
  const [nextCall, setNextCall] = useState<NextCall>(NO_NEXT_CALL);
  const [note, setNote] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "notice"; text: string } | null>(null);
  const [pendingExit, setPendingExit] = useState<"close" | "release" | null>(null);
  const [confirmFound, setConfirmFound] = useState(false);

  // Un `operationId` por formulario. Si cambia después de un envío, se
  // estrena otro: el mismo id con otro contenido lo rechaza la RPC (E3).
  const [operationId, setOperationId] = useState(newOperationId);
  const submittedRef = useRef<string | null>(null);
  const fingerprint = JSON.stringify([form, channel, outcome, courier, changes, agreedOn, nextCall.iso, note.trim(), closeNote.trim()]);
  useEffect(() => {
    if (submittedRef.current !== null && submittedRef.current !== fingerprint) {
      submittedRef.current = null;
      setOperationId(newOperationId());
    }
  }, [fingerprint]);

  const box = current.box;
  // Con la caja que no consta, «No esperar la caja» solo en un caso reabierto
  // (E29). La misma regla que el servidor (`reproBoxAction` con `reopened`).
  const showNoEsperar = noEsperarCajaAplica(box, current.reopened);
  const effectiveChanges: ReproChanges = showNoEsperar ? changes : { ...changes, no_esperar_caja: false };

  const boxInput = (c: ReproCourier): ReproBoxActionResult => reproBoxAction({
    outcome: "confirma",
    courier: c,
    changes: effectiveChanges,
    box,
    ownLiveCourier: current.boxInputs.ownLiveCourier,
    lastFailedCourier: current.boxInputs.lastFailedCourier,
    otherLiveCourier: current.boxInputs.otherLiveCourier,
    hadPropio: current.boxInputs.hadPropio,
    totalOutputs: current.boxInputs.totalOutputs,
    priorWithCourier: current.boxInputs.priorByCourier[c] ?? 0,
    ownReplace: current.boxInputs.ownReplace,
    reopened: current.reopened,
  });

  // Otra guía viva de otro courier: no se confirma nada aquí (la trabaja ese courier).
  const confirmBlocked = current.boxInputs.otherLiveCourier
    ? `La guía de ${reproCourierName(current.boxInputs.otherLiveCourier)} sigue viva: la trabaja ese courier. Revísala en la ficha.`
    : null;

  // Urpi va apagado con su porqué (E16); los demás, con el problema que daría
  // la caja con ese courier (las cinco salidas, una vez por courier en Lima).
  const courierOptions = [...REPRO_COURIER_CHOICES, "urpi" as const].map((c) => {
    const fixed = reproCourierDisabledReason(c);
    if (fixed) return { courier: c, reason: fixed };
    if (confirmBlocked) return { courier: c, reason: null };
    const result = boxInput(c);
    return { courier: c, reason: "problem" in result ? result.problem : null };
  });

  const decided = outcome === "confirma" && courier ? boxInput(courier) : null;
  const action = decided && "action" in decided ? decided.action : null;
  const plan = courier && action && action !== "desarmar_cerrar"
    ? materializationPlan({ courier, boxAction: action, box, retryAdmission: current.retryAdmission })
    : null;

  const tomorrow = nextDay(today);
  const maxDay = shiftDay(today, RESCHEDULE_MAX_DAYS);
  const dayProblem = (day: string): string | null => courier
    ? agreementDateProblem({ day, today, nowMinute: clock.minute, cutoff: current.cutoff, courier, boxAction: action })
    : null;
  const firstDay = courier ? firstAllowedDay(courier, current.cutoff, now, action) : today;
  const requested = current.requestedDate && current.requestedDate >= today && current.requestedDate <= maxDay ? current.requestedDate : null;
  const todayProblem = dayProblem(today);
  const tomorrowProblem = dayProblem(tomorrow);
  const swayp = courier === "fenix";

  function pickCourier(c: ReproCourier) {
    setCourier(c);
    // Una fecha que deja de servir con este courier se borra (p. ej. Swayp «hoy»).
    if (agreedOn) {
      const problem = agreementDateProblem({ day: agreedOn, today, nowMinute: clock.minute, cutoff: current.cutoff, courier: c, boxAction: null });
      if (problem) { setAgreedOn(""); setOtherDate(false); }
    }
  }

  function pickOutcome(o: ReproOutcome) {
    setOutcome(o);
    setFeedback(null);
    setConfirmClose(false);
    if (o === "no_contesta") {
      // La próxima vuelta de llamadas, preseleccionada; se puede quitar.
      const round = nextRoundAt(new Date());
      setNextCall({ kind: round.includes("T15:00") ? "hoy" : "manana", iso: round, input: "" });
    } else if (o === "llamar_despues") {
      setNextCall(NO_NEXT_CALL);
    }
  }

  // Lo que impide guardar, dicho con palabras (junto al botón).
  const blocker: string | null = (() => {
    if (!mine) return null;
    if (form === "close") {
      const reason = validarMotivoDescarte(closeNote);
      return "error" in reason ? reason.error : null;
    }
    if (!outcome) return "Elige el resultado de la llamada.";
    switch (outcome) {
      case "confirma":
        if (confirmBlocked) return confirmBlocked;
        if (!courier) return "Elige con qué courier sale.";
        if (decided && "problem" in decided) return decided.problem;
        if (!agreedOn) return "Elige el día que acordaste con el cliente.";
        return dayProblem(agreedOn);
      case "llamar_despues":
        return nextCallProblem(nextCall.iso, now);
      case "no_contesta":
        return nextCall.kind && nextCall.kind !== "ninguna" ? nextCallProblem(nextCall.iso, now) : null;
      case "no_quiere": {
        const reason = validarMotivoDescarte(note);
        return "error" in reason ? reason.error : null;
      }
    }
  })();

  const destructive = form === "close" || outcome === "no_quiere";
  const hasDraft = note.trim().length > 0 || closeNote.trim().length > 0;

  function finish(result: RegisterReproCallResult, advance: boolean) {
    if (result.callId) {
      releaseCurrentClaim();
      onSaved({
        orderId,
        orderName: current.orderName,
        notice: result.notice ?? null,
        error: result.error ?? null,
        mesa: Boolean(result.href),
      }, advance);
      return;
    }
    if (result.claimLost) {
      // Ya no tiene el caso (D10): la hoja lo dice, conserva lo escrito y
      // ofrece «Volver a tomarlo».
      setClaimState("lost");
      setClaimMessage(result.error ?? null);
      return;
    }
    setFeedback({ kind: "error", text: result.error ?? "No se pudo guardar. Vuelve a intentarlo." });
    if (result.boxChanged) {
      // La caja cambió mientras se decidía (§9.5): se releen los hechos para
      // recalcular «Qué hacer con la caja». Lo escrito se queda.
      void reload();
      onChanged();
    }
  }

  function save(advance: boolean) {
    const id = caseId ?? current.caseId;
    if (!mine || !id || blocker) return;
    if (destructive && !confirmClose) { setConfirmClose(true); return; }
    submittedRef.current = fingerprint;
    setFeedback(null);
    if (form === "close") {
      start(async () => {
        const result = await closeReproCase({ caseId: id, operationId, note: closeNote, confirmOrderName: current.orderName })
          .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }) as RegisterReproCallResult);
        finish(result, advance);
      });
      return;
    }
    if (!outcome) return;
    const input: RegisterReproCallInput = {
      caseId: id,
      operationId,
      outcome,
      channel,
      note: note.trim() || null,
    };
    if (outcome === "llamar_despues" || outcome === "no_contesta") input.nextCallAt = nextCall.kind === "ninguna" ? null : nextCall.iso;
    if (outcome === "confirma") {
      input.agreedOn = agreedOn;
      input.courier = courier;
      input.changes = effectiveChanges;
      input.expectedBoxAction = action;
    }
    if (outcome === "no_quiere") input.confirmOrderName = current.orderName;
    start(async () => {
      const result = await registerReproCall(input)
        .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }) as RegisterReproCallResult);
      finish(result, advance);
    });
  }

  function program(found: boolean) {
    const id = current.caseId ?? caseId;
    if (!id) return;
    if (found && !confirmFound) { setConfirmFound(true); return; }
    setConfirmFound(false);
    setFeedback(null);
    start(async () => {
      const result: ReproActionResult = await programReproAgreement({ caseId: id, ...(found ? { found: true } : {}) })
        .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      setFeedback(result.error ? { kind: "error", text: result.error } : { kind: "notice", text: result.notice ?? "Programado." });
      onChanged();
      void reload();
    });
  }

  // Salir: cerrar la hoja o soltar el caso. Con texto sin guardar, se avisa (§11.5).
  function requestExit(kind: "close" | "release") {
    if ((mine || claimState === "lost") && hasDraft) { setPendingExit(kind); return; }
    doExit();
  }
  function doExit() {
    releaseCurrentClaim();
    onClose();
  }

  // Escape cierra la hoja (no la ficha que se abra encima).
  const bodyRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef(requestExit);
  useEffect(() => { exitRef.current = requestExit; });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const dialog = bodyRef.current?.closest('[role="dialog"]');
      if (!dialog || !(event.target instanceof Node) || !dialog.contains(event.target)) return;
      exitRef.current("close");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const agreement = current.agreement;
  const showProgramNow = Boolean(agreement) && current.state.kind === "por_programar" && current.list !== "cerrados";
  const showFound = Boolean(agreement) && current.state.kind === "falta_ubicar";
  const whatsapp = whatsappHref(current.customerPhone);
  const visibleCalls = calls ? (allCalls ? calls : calls.slice(0, 5)) : null;
  const cut = sameDayCutoffLabel(current.cutoff);

  const claimLine: ReactNode = (() => {
    if (mode === "read") {
      return current.claim.view === "otro"
        ? `${current.claim.byName ?? "Otra persona"} está atendiendo este pedido. Solo lectura.`
        : "Solo lectura: no toma el caso.";
    }
    switch (claimState) {
      case "idle":
      case "claiming":
        return "Tomando el caso…";
      case "mine":
        return `Lo atiendes tú${claimUntil ? ` · se libera a las ${limaHour(claimUntil)} si no hay actividad` : ""}.`;
      case "held":
        return `${holder?.name ?? "Otra persona"} está atendiendo este pedido${holder?.until ? `; se libera a las ${limaHour(holder.until)}` : ""}.`;
      case "lost":
        return claimMessage ?? "Ya no tienes este caso: vuelve a tomarlo.";
      case "reopen":
        return "Cerrado con «Desarmar y cerrar».";
      case "error":
        return claimMessage ?? "No pudimos tomar el caso.";
    }
  })();
  const claimDot = mine ? "bg-ok-fg" : claimState === "held" || claimState === "lost" ? "bg-warn-fg" : "bg-ink-300";

  return (
    <SidePanel
      label={`Repro Lima: ${current.orderName}`}
      title={current.orderName}
      badge={<Badge tone="neutral">{REPRO_LIST_LABEL[current.list]}</Badge>}
      meta={[current.customerName, current.district ?? "sin distrito", soles(current.orderTotal), current.storeName].join(" · ")}
      width="sm:max-w-[560px]"
      onClose={() => requestExit("close")}
    >
      <div ref={bodyRef} className="space-y-5">
        {/* El aviso del pedido anterior («Guardar y pasar al siguiente»). */}
        {previous && (
          <Banner tone="ok" role="status" title={previous.orderName}>
            <p>{previous.text}</p>
          </Banner>
        )}
        {/* El candado, en una línea con su punto. */}
        <div className="space-y-2">
          <p className="flex items-start gap-2 text-[13px] leading-5 text-ink-600" aria-live="polite">
            <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", claimDot, (claimState === "claiming" || claimState === "idle") && mode === "edit" && "animate-pulse motion-reduce:animate-none")} />
            <span>{claimLine}</span>
          </p>
          {claimState === "held" && (
            <OpsButton size="sm" onClick={() => setClaimAttempt((n) => n + 1)}>Reintentar</OpsButton>
          )}
          {claimState === "lost" && (
            <Banner tone="warn" role="alert" title="Ya no tienes este caso">
              <p>Lo que escribiste sigue aquí. Vuelve a tomarlo para guardarlo.</p>
              <OpsButton size="sm" className="mt-2 pointer-coarse:h-11" onClick={() => setClaimAttempt((n) => n + 1)}>Volver a tomarlo</OpsButton>
            </Banner>
          )}
          {showReopen && (mode === "read" || claimState === "reopen") && (
            <Banner tone="warn" role="alert" title="Este pedido se cerró con «Desarmar y cerrar»">
              <p>Si Almacén ya la desarmó, elige «No esperar la caja».</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <OpsButton
                  size="sm"
                  variant="primary"
                  className="pointer-coarse:h-11"
                  onClick={() => { setShowReopen(false); reopenRef.current = true; setMode("edit"); setClaimAttempt((n) => n + 1); }}
                >
                  Sí, volver a atender
                </OpsButton>
                <OpsButton size="sm" variant="ghost" className="pointer-coarse:h-11" onClick={() => setShowReopen(false)}>Cancelar</OpsButton>
              </div>
            </Banner>
          )}
          {gone && (
            <Banner tone="warn" role="alert">Este pedido ya no está en «Por reprogramar Lima».</Banner>
          )}
          {loadError && <Banner tone="crit" role="alert">{loadError}</Banner>}
        </div>

        {/* Llamar, escribir y la ficha: lo primero que se toca. */}
        <div className="flex flex-wrap gap-2">
          <CallButton phone={current.customerPhone} size="lg" className="grow sm:grow-0" />
          {whatsapp && (
            <a href={whatsapp} target="_blank" rel="noreferrer" className={opsButtonClass("secondary", "lg")} aria-label="Escribir por WhatsApp">
              <IconWhatsApp aria-hidden />
              <span className="hidden sm:inline">WhatsApp</span>
            </a>
          )}
          <OpsButton size="lg" variant="ghost" onClick={() => openDrawer(orderId)}>Ver ficha</OpsButton>
        </div>

        <Section title="Antes de llamar">
          <FailureLine row={current} />
          <div className="flex flex-wrap gap-1.5">
            <ReproRowChips row={current} today={today} />
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] leading-5">
            <dt className="text-ink-500">Pidió</dt>
            <dd className="text-ink-900">
              {current.requestedDate
                ? `${programDayLabel(current.requestedDate)} · ${current.requestedDate < today ? "ya pasó" : "sin confirmar"}`
                : "No consta una fecha pedida"}
            </dd>
            <dt className="text-ink-500">Salidas</dt>
            <dd className="text-ink-900">{outputsLine(current).replace(/^Salidas /, "")}</dd>
            {current.program && (
              <>
                <dt className="text-ink-500">Grupo GF</dt>
                <dd className="text-ink-900">
                  {`Programado para el ${programDayLabel(current.program.scheduledFor)}`}
                  {current.program.reason ? ` · «${current.program.reason}»` : ""}
                </dd>
              </>
            )}
          </dl>
          <div>
            <p className="text-[13px] font-semibold text-ink-700">Llamadas anteriores</p>
            {calls === null ? (
              <Skeleton className="mt-2 h-10" />
            ) : calls.length === 0 ? (
              <p className="mt-1 text-[13px] text-ink-500">Todavía nadie llamó por este pedido.</p>
            ) : (
              <>
                <ul className="mt-1 divide-y divide-line border-y border-line">
                  {visibleCalls!.map((call) => {
                    const line = callLine(call, today, now);
                    return (
                      <li key={call.id} className="py-2 text-[13px] leading-5">
                        <p className="tabular-nums text-ink-900">{line.head}</p>
                        {line.detail && <p className="text-ink-600">{line.detail}</p>}
                      </li>
                    );
                  })}
                </ul>
                {calls.length > 5 && (
                  <OpsButton size="sm" variant="ghost" className="mt-1" onClick={() => setAllCalls((v) => !v)}>
                    {allCalls ? "Ver menos" : `Ver las ${calls.length}`}
                  </OpsButton>
                )}
              </>
            )}
          </div>
        </Section>

        {/* El acuerdo vigente o el cierre, para leer (E29). */}
        {agreement && (
          <Section title="Acuerdo">
            <p className="text-sm text-ink-900">
              {`Sale el ${programDayLabel(agreement.agreedOn)} con ${agreement.courierName}`}
              {agreement.decidedByName ? ` · lo confirmó ${agreement.decidedByName}` : ""}
              {agreement.decidedAt ? ` (${limaStamp(agreement.decidedAt, today)})` : ""}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={stateTone(current.state.kind)} wrap>{current.stateLabel}</Badge>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] leading-5">
              <dt className="text-ink-500">Caja</dt>
              <dd className="text-ink-900">{agreement.boxAction && isBoxAction(agreement.boxAction) ? BOX_ACTION_LABEL[agreement.boxAction] : "—"}</dd>
              <dt className="text-ink-500">Cambios</dt>
              <dd className="text-ink-900">{reproChangesText(agreement.changes) ?? "Ninguno"}</dd>
              {current.plan && isReproCourier(agreement.courier) && (
                <>
                  <dt className="text-ink-500">Se programa</dt>
                  <dd className="text-ink-900">{planText(current.plan, agreement.courier, current.box)}</dd>
                </>
              )}
            </dl>
            {current.state.kind === "otro_courier" && (
              <OrderLink orderId={orderId} section="operar" className={opsButtonClass("secondary", "sm", "pointer-coarse:h-11")}>
                Crear la salida en la Mesa de ruta
              </OrderLink>
            )}
            {(showProgramNow || showFound) && (
              <div className="flex flex-wrap items-center gap-2">
                {showProgramNow && (
                  <OpsButton size="sm" variant="primary" disabled={pending} onClick={() => program(false)} className="pointer-coarse:h-11">
                    Programar ahora
                  </OpsButton>
                )}
                {showFound && (
                  confirmFound ? (
                    <>
                      <OpsButton size="sm" variant="primary" disabled={pending} onClick={() => program(true)} className="pointer-coarse:h-11">
                        La caja está en la oficina
                      </OpsButton>
                      <OpsButton size="sm" variant="ghost" onClick={() => setConfirmFound(false)} className="pointer-coarse:h-11">Cancelar</OpsButton>
                    </>
                  ) : (
                    <OpsButton size="sm" disabled={pending} onClick={() => program(true)} className="pointer-coarse:h-11">
                      Ya la encontré: programar
                    </OpsButton>
                  )
                )}
              </div>
            )}
          </Section>
        )}
        {current.closed && (
          <Section title="Cerrado">
            <p className="text-sm text-ink-900">
              {`Desarmar y cerrar${current.closed.byName ? ` · ${current.closed.byName}` : ""}${current.closed.at ? ` · ${limaStamp(current.closed.at, today)}` : ""}`}
            </p>
            {current.closed.note && <p className="text-[13px] text-ink-700">«{current.closed.note}»</p>}
            <p className="text-[13px] text-ink-500">
              Almacén la desarma cuando esté en oficina (cuaderno «DESARMAR»). No anula la venta: solo Shopify la anula.
            </p>
          </Section>
        )}

        {/* El formulario: solo con el caso tomado. */}
        {mode === "edit" && claimState === "claiming" && (
          <div className="space-y-2 border-t border-line pt-4" aria-hidden>
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-24" />
          </div>
        )}
        {(mine || claimState === "lost") && (
          <fieldset disabled={claimState === "lost"} className="contents">
            {form === "call" ? (
              <>
                <Section title="Canal">
                  <div role="group" aria-label="Canal" className="flex flex-wrap gap-1.5">
                    <Chip label="Llamada" active={channel === "llamada"} onClick={() => setChannel("llamada")} />
                    <Chip label="WhatsApp" active={channel === "whatsapp"} onClick={() => setChannel("whatsapp")} />
                  </div>
                </Section>

                <Section title="Resultado">
                  <div role="group" aria-label="Resultado" className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
                    {(["confirma", "llamar_despues", "no_contesta", "no_quiere"] as const).map((o) => (
                      <OptionTile
                        key={o}
                        label={REPRO_OUTCOME_LABEL[o]}
                        description={
                          o === "confirma" && confirmBlocked
                            ? <span className="text-warn-fg">{confirmBlocked}</span>
                            : o === "no_contesta"
                              ? `Suma un intento: van ${current.noAnswerCount + 1}.`
                              : OUTCOME_HELP[o]
                        }
                        active={outcome === o}
                        danger={o === "no_quiere"}
                        disabled={o === "confirma" && Boolean(confirmBlocked)}
                        onClick={() => pickOutcome(o)}
                      />
                    ))}
                  </div>
                </Section>

                {outcome === "confirma" && !confirmBlocked && (
                  <>
                    <Section title="Courier">
                      <div role="group" aria-label="Courier" className="flex flex-wrap gap-1.5">
                        {courierOptions.map((option) => (
                          <Chip
                            key={option.courier}
                            label={REPRO_COURIER_LABEL[option.courier]}
                            active={courier === option.courier}
                            disabled={Boolean(option.reason) && courier !== option.courier}
                            title={option.reason ?? undefined}
                            onClick={() => pickCourier(option.courier)}
                          />
                        ))}
                      </div>
                      {courierOptions.some((o) => o.reason) && (
                        <ul className="space-y-0.5 text-[13px] leading-5 text-warn-fg">
                          {courierOptions.filter((o) => o.reason).map((o) => (
                            <li key={o.courier}><b className="font-semibold">{REPRO_COURIER_LABEL[o.courier]}:</b> {o.reason}</li>
                          ))}
                        </ul>
                      )}
                    </Section>

                    <Section title="Fecha">
                      {swayp ? (
                        <div className="space-y-1">
                          {/* Hasta los 60 días del servidor: una fecha que viene de otro courier se ve. */}
                          <SwaypDispatchDateSelect value={agreedOn} lastDay={maxDay} onChange={(value) => { setAgreedOn(value); setOtherDate(false); }} className={cn(FIELD, "max-w-xs")} />
                          <p className="text-[13px] text-ink-500">
                            Swayp arma su ruta el día anterior: desde mañana, de lunes a sábado.
                            {current.requestedDate ? ` El cliente pidió el ${programDayLabel(current.requestedDate)}.` : ""}
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div role="group" aria-label="Fecha" className="flex flex-wrap gap-1.5">
                            <Chip
                              label={requested === today ? "Hoy · lo pidió" : "Hoy"}
                              active={!otherDate && agreedOn === today}
                              disabled={Boolean(todayProblem)}
                              title={todayProblem ?? undefined}
                              onClick={() => { setAgreedOn(today); setOtherDate(false); }}
                            />
                            <Chip
                              label={requested === tomorrow ? "Mañana · lo pidió" : "Mañana"}
                              active={!otherDate && agreedOn === tomorrow}
                              disabled={Boolean(tomorrowProblem)}
                              title={tomorrowProblem ?? undefined}
                              onClick={() => { setAgreedOn(tomorrow); setOtherDate(false); }}
                            />
                            {requested && requested !== today && requested !== tomorrow && (
                              <Chip
                                label={`Pidió: ${programDayLabel(requested)}`}
                                active={!otherDate && agreedOn === requested}
                                disabled={Boolean(dayProblem(requested))}
                                title={dayProblem(requested) ?? undefined}
                                onClick={() => { setAgreedOn(requested); setOtherDate(false); }}
                              />
                            )}
                            <Chip label="Otra fecha" active={otherDate} onClick={() => { setOtherDate(true); setAgreedOn(""); }} />
                          </div>
                          {todayProblem && <p className="text-[13px] leading-5 text-ink-500">Hoy no: {todayProblem}</p>}
                          {otherDate && (
                            <label className="block max-w-xs text-[13px] text-ink-600">
                              Día acordado
                              <input
                                type="date"
                                value={agreedOn}
                                min={firstDay}
                                max={maxDay}
                                onChange={(e) => setAgreedOn(e.target.value)}
                                className={cn(FIELD, "mt-1")}
                              />
                            </label>
                          )}
                        </div>
                      )}
                      {agreedOn && courier && !dayProblem(agreedOn) && (
                        <p className="text-[13px] text-ink-700">{`Sale el ${programDayLabel(agreedOn)} con ${REPRO_COURIER_LABEL[courier]}.`}</p>
                      )}
                      {plan === "al_recibir" && agreedOn === today && box.kind === "con_motorizado" && (
                        <p className="text-[13px] leading-5 text-warn-fg">
                          {`La caja sigue con ${box.riderName}: solo sale hoy si llega a la oficina antes del corte de las ${cut}.`}
                        </p>
                      )}
                    </Section>

                    <Section title="¿Qué cambió?">
                      <div className="grid gap-2 sm:grid-cols-2">
                        {CHANGE_FIELDS.map((field) => (
                          <label key={field.key} className="flex min-h-8 items-start gap-2 text-sm text-ink-900 pointer-coarse:min-h-11">
                            <input
                              type="checkbox"
                              className={cn(CHECKBOX, "mt-0.5")}
                              checked={changes[field.key]}
                              onChange={(e) => setChanges((prev) => ({ ...prev, [field.key]: e.target.checked }))}
                            />
                            {field.label}
                          </label>
                        ))}
                      </div>
                      {showNoEsperar && (
                        <label className="flex items-start gap-2 rounded-lg bg-wash px-3 py-2.5 text-sm text-ink-900">
                          <input
                            type="checkbox"
                            className={cn(CHECKBOX, "mt-0.5")}
                            checked={changes.no_esperar_caja}
                            onChange={(e) => setChanges((prev) => ({ ...prev, no_esperar_caja: e.target.checked }))}
                          />
                          <span>
                            <span className="font-semibold">No esperar la caja</span>
                            <span className="block text-[13px] text-ink-600">El cliente lo quiere ya: se arma otra caja desde stock.</span>
                          </span>
                        </label>
                      )}
                      {showNoEsperar && changes.producto && !changes.no_esperar_caja && box.kind !== "desconocida" && (
                        <p className="text-[13px] leading-5 text-ink-600">Con el producto cambiado, «No esperar la caja» arma una caja nueva desde stock.</p>
                      )}
                    </Section>

                    {courier && (
                      <div className="space-y-1 rounded-lg bg-wash px-3 py-2.5 text-[13px] leading-5" aria-live="polite">
                        {decided && "problem" in decided ? (
                          <p className="text-warn-fg"><b className="font-semibold">Qué hacer con la caja:</b> {decided.problem}</p>
                        ) : decided ? (
                          <>
                            <p className="text-ink-900"><b className="font-semibold">Qué hacer con la caja:</b> {decided.label}</p>
                            <p className="text-ink-600">{boxActionReadyLabel(decided.action, courier, current.cutoff)}</p>
                            {plan && <p className="text-ink-900"><b className="font-semibold">Se programa:</b> {planText(plan, courier, box)}</p>}
                          </>
                        ) : null}
                      </div>
                    )}
                  </>
                )}

                {(outcome === "llamar_despues" || outcome === "no_contesta") && (
                  <Section title={outcome === "llamar_despues" ? "¿Cuándo vuelves a llamar?" : "Próxima llamada"}>
                    <NextCallPicker now={now} value={nextCall} optional={outcome === "no_contesta"} onChange={setNextCall} />
                  </Section>
                )}

                {outcome && (
                  <Section title={outcome === "no_quiere" ? "Motivo" : "Nota"}>
                    <label className="block">
                      <span className="sr-only">{outcome === "no_quiere" ? "Motivo" : "Nota"}</span>
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={3}
                        maxLength={1000}
                        placeholder={outcome === "no_quiere" ? `Por qué ya no lo quiere (mínimo ${DISCARD_REASON_MIN} caracteres)` : "Lo que dijo el cliente (opcional)"}
                        className={cn(FIELD, "h-auto py-2")}
                      />
                    </label>
                  </Section>
                )}
              </>
            ) : (
              <Section title="Desarmar y cerrar sin llamada">
                <p className="text-[13px] leading-5 text-ink-600">
                  Para el plazo sugerido (10 días en oficina y 3 llamadas sin respuesta). Es una decisión de la tienda: Kapta no la toma sola.
                </p>
                <label className="block">
                  <span className="sr-only">Motivo</span>
                  <textarea
                    value={closeNote}
                    onChange={(e) => setCloseNote(e.target.value)}
                    rows={3}
                    maxLength={500}
                    placeholder={`Motivo (mínimo ${DISCARD_REASON_MIN} caracteres)`}
                    className={cn(FIELD, "h-auto py-2")}
                  />
                </label>
              </Section>
            )}
          </fieldset>
        )}

        {/* El pie fijo: los avisos y los botones, al alcance del pulgar. */}
        <div className="sticky bottom-0 -mx-4 -mb-5 space-y-2 border-t border-line bg-white px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:-mx-6 sm:px-6">
          {feedback && (
            <Banner tone={feedback.kind === "error" ? "crit" : "ok"} role={feedback.kind === "error" ? "alert" : "status"}>
              {feedback.text}
            </Banner>
          )}
          {pendingExit && (
            <Banner tone="warn" role="alert">
              <p>Escribiste algo que todavía no se guardó. Si {pendingExit === "release" ? "sueltas el caso" : "cierras"}, se descarta.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <OpsButton size="sm" className="pointer-coarse:h-11" onClick={() => setPendingExit(null)}>Seguir aquí</OpsButton>
                <OpsButton size="sm" variant="danger" className="pointer-coarse:h-11" onClick={doExit}>
                  {pendingExit === "release" ? "Descartar y soltar" : "Descartar y cerrar"}
                </OpsButton>
              </div>
            </Banner>
          )}
          {mine && confirmClose && destructive && !blocker && (
            <Banner tone="warn" role="alert" title="Almacén desarma la caja cuando esté en oficina">
              <p>No anula la venta: solo Shopify la anula.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <OpsButton size="sm" variant="danger" disabled={pending} className="whitespace-normal pointer-coarse:h-11" onClick={() => save(hasNext)}>
                  Sí, desarmar y cerrar {current.orderName}
                </OpsButton>
                <OpsButton size="sm" variant="ghost" className="pointer-coarse:h-11" onClick={() => setConfirmClose(false)}>Cancelar</OpsButton>
              </div>
            </Banner>
          )}
          {mine && blocker && (
            <p id="repro-save-blocker" className={cn("text-[13px] leading-5", outcome || form === "close" ? "text-warn-fg" : "text-ink-500")}>{blocker}</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {mine && !(confirmClose && destructive) && (
              <OpsButton
                variant={destructive ? "danger" : "primary"}
                size="lg"
                disabled={pending || Boolean(blocker)}
                aria-describedby={blocker ? "repro-save-blocker" : undefined}
                onClick={() => save(hasNext)}
                className="grow sm:grow-0"
              >
                {pending ? "Guardando…" : destructive ? "Desarmar y cerrar" : hasNext ? "Guardar y pasar al siguiente" : "Guardar"}
              </OpsButton>
            )}
            {mine && (
              <OpsButton
                variant={form === "close" ? "secondary" : "danger"}
                size="sm"
                className="pointer-coarse:h-11"
                onClick={() => { setForm(form === "close" ? "call" : "close"); setConfirmClose(false); setFeedback(null); }}
              >
                {form === "close" ? "Volver a la llamada" : "Desarmar y cerrar sin llamada"}
              </OpsButton>
            )}
            {mode === "read" && current.list === "programados" && current.claim.view !== "otro" && (
              <OpsButton size="sm" className="pointer-coarse:h-11" onClick={() => setMode("edit")}>
                {agreement ? "Cambiar el acuerdo" : "Atender"}
              </OpsButton>
            )}
            {mode === "read" && current.list === "cerrados" && !showReopen && (
              <OpsButton size="sm" className="pointer-coarse:h-11" onClick={() => setShowReopen(true)}>Volver a atender</OpsButton>
            )}
            <OpsButton size="sm" variant="ghost" className="pointer-coarse:h-11" onClick={() => openDrawer(orderId)}>Ver ficha</OpsButton>
            {mine ? (
              <OpsButton size="sm" variant="ghost" className="pointer-coarse:h-11" onClick={() => requestExit("release")}>Soltar</OpsButton>
            ) : (
              <OpsButton size="sm" variant="ghost" className="pointer-coarse:h-11" onClick={() => requestExit("close")}>Cerrar</OpsButton>
            )}
          </div>
        </div>
      </div>
    </SidePanel>
  );
}
