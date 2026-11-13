"use client";

// Panel «Automatizaciones» (MOM §40, 04-11-2026): un solo lugar para encender
// y apagar lo que crea guías, llama o escribe a clientas sin que una persona
// lo dispare. Página de ajustes del mundo de operación (DESIGN.md › «Página
// de ajustes»): índice a la izquierda, grupos y secciones, tarjetas con filas.
//
// Diferencia con Ajustes: aquí cada interruptor GUARDA AL CAMBIAR, sin
// «Guardar» de tarjeta. El owner viene a apagar algo que está saliendo mal;
// un cambio que se queda «sin guardar» es justo el error que el panel evita.
// Por eso el interruptor de esta página es controlado (un botón con
// `role="switch"`) y no el `Switch` de formulario de `settings-ui`, aunque se
// vea igual. Lo que sale de Kapta y no se deshace (guías, llamadas, WhatsApp,
// confirmaciones) pide confirmación antes de encenderse.

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition, type KeyboardEvent, type ReactNode } from "react";
import { EmptyState, cn } from "@/components/ui";
import { Badge, Banner, OpsButton, type BadgeTone } from "@/components/ops-ui";
import { opsButtonClass } from "@/components/ops-styles";
import { CARD, CardHeader, HELP, NUMBER_NARROW, ROW, SettingsGroup, SettingsIndex, SettingsSection, type IndexGroup } from "@/components/settings-ui";
import { CHAIN_REASONS, type ChainReason } from "@/lib/lima-retry-chain";
import {
  RETRY_DAILY_CAP_MAX,
  RETRY_DAILY_CAP_MIN,
  RETRY_MODE_LABEL,
  RETRY_MODES,
  RETRY_REASON_LABEL,
  RETRY_STEPS,
  RETRY_VARIANTS,
  retryVariantLabel,
  type RetryMode,
  type RetryOutcome,
  type RetryVariant,
} from "@/lib/lima-retry-auto";
import {
  AUTOMATIONS,
  AUTOMATION_GROUPS,
  confirmationText,
  needsConfirmation,
  storeSettingsHref,
  CHATBY_ASK_KEY,
  CHATBY_HISTORY_KEY,
  type AutomationEffect,
  type AutomationEntry,
  type AutomationGroup,
} from "@/lib/automations-catalog";
import type { AutomationsOrgView, OrgSwitchView, RetryChatbyAskView, RetryGeocodeView, RetryLogView, StoreSwitchView } from "@/lib/automations-access";
import type { ApproxReportRow, ChatbyApproxView } from "@/lib/chatby-approx-server";
import type { ChatbyAskModeView } from "@/lib/chatby-auto-ask-server";
import {
  APPROX_MODE_LABEL,
  APPROX_NEAR_METERS,
  approxSummaryLine,
  mapsHref,
  type ApproxMode,
  type ApproxReference,
} from "@/lib/geocode-approx";
import {
  GEOCODE_CRITERION_B,
  GEOCODE_LIMA_CAP,
  GEOCODE_REASON_LABEL,
  GEOCODE_LIMA_MIN_ROOFTOP,
  geocodeLimaGate,
  type GeocodeLimaRunSummary,
  type GeocodePilotReason,
} from "@/lib/geocode-google";
import {
  PREPAY_LIST_PATH,
} from "@/lib/prepay-list";
import { LN_EMPTY_EXCEPTIONS, LN_EXCEPTION_REMOVE, LN_NAME, LN_PANEL_REQUIREMENT_LABEL, LN_PANEL_TITLE, lnMotivoInline } from "@/lib/lista-negra-copy";
import {
  PAGO_ONLINE_LABEL,
  PAGO_ONLINE_REQUIREMENT_LABEL,
  PAGO_ONLINE_REQUIREMENTS,
  type PagoOnlineMode,
  type PagoOnlineRequirement,
} from "@/lib/pago-online";
import type { PagoOnlineRunView } from "@/lib/pago-online-view";
import {
  acceptPagoOnlineList,
  emptyPagoOnlineStoreList,
  removePagoOnlineExceptionAction,
  runPagoOnlineNow,
  sendPagoOnlineTestList,
  setPagoOnlineMode,
  setPagoOnlineRequirement,
} from "@/app/dashboard/automatizaciones/actions";
import {
  measureLimaGeocodeNow,
  setChatbyApproxMode,
  setChatbyAskMode,
  setChatbyHistoryMode,
  setOrgAutomation,
  setRetryChatbyAsk,
  setRetryDailyCap,
  setRetryGeocode,
  setRetryVariantMode,
  setStoreAutomation,
  simulateRetriesNow,
  type AutomationActionResult,
  type LimaGeocodeMeasureResult,
  type RetrySimulationResult,
} from "@/app/dashboard/automatizaciones/actions";

type Status = { kind: "ok" | "error"; text: string } | null;

/**
 * Una acción que no llegó a responder (la red se cortó, el servidor se cayó a
 * medias). Las acciones devuelven `{ error }` en los casos esperados y nunca
 * lanzan; lo que lanza es el camino, no la regla. Sin atraparlo, React lo
 * manda al límite de errores, el panel se queda en blanco y el «Guardando…»
 * no termina nunca.
 */
const NETWORK_ERROR = "No se pudo guardar. Revisa la conexión y vuelve a intentar.";

/** Lo que se dice tras guardar: «Guardado», o el aviso si quedó algo a medias. */
function statusOf(result: AutomationActionResult): Status {
  if (result.error) return { kind: "error", text: result.error };
  if (result.notice?.startsWith("Guardado, pero")) return { kind: "error", text: result.notice };
  return { kind: "ok", text: "Guardado" };
}

const EFFECT_TONE: Record<AutomationEffect, BadgeTone> = {
  "Crea guías": "orange",
  "Envía WhatsApp": "emerald",
  "Llama a clientas": "sky",
  "Confirma pedidos": "indigo",
  "Solo informa": "slate",
  "Crea pedidos": "teal",
  "Valida pagos": "teal",
  "Emite comprobantes": "teal",
  "Registra despachos": "slate",
  "Cancela en la tienda": "teal",
  "Ordena el trabajo": "slate",
};

const OUTCOME_TONE: Partial<Record<RetryOutcome, BadgeTone>> = {
  creada: "ok",
  simulada: "info",
  fallo: "crit",
  incierto: "warn",
  sin_transporte: "warn",
  sin_ubicacion: "warn",
};

const groupId = (key: AutomationGroup) => `grupo-${key}`;
const APPROX_TEST_ID = "prueba-ubicacion-aproximada";

const INDEX: IndexGroup[] = [
  {
    title: "Reintentos Aliclik en Lima",
    items: [
      { id: "retry-variantes", label: "Posición de cada reintento" },
      { id: "retry-tope", label: "Tope del día" },
      { id: "retry-ubicacion", label: "Ubicación por dirección" },
      { id: "retry-whatsapp", label: "Ubicación por WhatsApp" },
      { id: "retry-simular", label: "Simular ahora" },
      { id: "retry-registro", label: "Hoy y ayer" },
    ],
  },
  {
    title: LN_PANEL_TITLE,
    items: [
      { id: "pago-online-posicion", label: "Posición y cobro" },
      { id: "pago-online-tiendas", label: "Envío a las tiendas" },
      { id: "pago-online-prueba", label: "Enviar prueba" },
      { id: "pago-online-excepciones", label: "Excepciones" },
    ],
  },
  {
    title: "Interruptores",
    items: AUTOMATION_GROUPS.flatMap((g) => [
      { id: groupId(g.key), label: g.title },
      // La prueba de la ubicación aproximada va con la Confirmación (0316).
      ...(g.key === "confirmacion" ? [{ id: APPROX_TEST_ID, label: "Prueba de ubicación aproximada" }] : []),
    ]),
  },
  { title: "Historial", items: [{ id: "ultimos-cambios", label: "Últimos cambios" }] },
];

export function AutomationsPanel({ orgs, writable }: { orgs: AutomationsOrgView[]; writable: boolean }) {
  const [orgId, setOrgId] = useState(orgs[0]?.orgId ?? "");
  const org = orgs.find((o) => o.orgId === orgId) ?? orgs[0];
  if (!org) return <EmptyState title="Sin organización">No tienes ninguna organización donde cambiar automatizaciones.</EmptyState>;

  return (
    <div className="mx-auto max-w-[76rem]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Automatizaciones</h1>
          <p className="mt-1 max-w-[72ch] text-sm text-ink-500">
            Un solo lugar para encender y apagar cada automatización. Todo lo que crea guías, llama o envía mensajes por su cuenta está aquí.
          </p>
        </div>
        {/* MOM §42: los tokens con los que un agente de IA (Grok Bot) consulta Kapta. */}
        <Link href="/dashboard/automatizaciones/conector" className={opsButtonClass("secondary", "md", "pointer-coarse:h-11")}>
          Conector de IA
        </Link>
        {orgs.length > 1 && (
          <label className="flex items-center gap-2 text-[13px] font-medium text-ink-600">
            Organización
            <select
              value={org.orgId}
              onChange={(e) => setOrgId(e.target.value)}
              className="block h-9 rounded-md border-0 bg-white px-3 text-sm text-ink-900 shadow-control ring-1 ring-inset ring-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 pointer-coarse:h-11"
            >
              {orgs.map((o) => (
                <option key={o.orgId} value={o.orgId}>
                  {o.orgName}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {!writable && (
        <Banner tone="info" role="status" className="mt-6" title="Solo lectura en este entorno">
          Los cambios se guardan solo en producción. Aquí ves el estado, pero los interruptores no se mueven.
        </Banner>
      )}
      {org.errors.length > 0 && (
        <Banner tone="warn" role="status" className="mt-4" title="Parte del panel no se pudo leer">
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {org.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Banner>
      )}

      <div className="mt-8">
        {/* La clave remonta el panel al cambiar de organización: nada de un estado local de otra. */}
        <SettingsIndex groups={INDEX} key={org.orgId}>
          <RetryGroup org={org} writable={writable} />
          <PagoOnlineGroup org={org} writable={writable} />
          <SettingsGroup title="Interruptores" description="Cada uno guarda al moverlo. Los que salen de Kapta piden confirmación antes de encenderse.">
            {AUTOMATION_GROUPS.map((group) => (
              <CatalogSection key={group.key} group={group} org={org} writable={writable} />
            ))}
          </SettingsGroup>
          <SettingsGroup title="Historial">
            <EventsSection org={org} />
          </SettingsGroup>
        </SettingsIndex>
      </div>
    </div>
  );
}

// ── Piezas comunes ──────────────────────────────────────────────────────────

/**
 * El interruptor que guarda al cambiar. Se ve como el `Switch` de Ajustes
 * (DESIGN.md › «Interruptor»): pista de 36 × 20, apagado blanco con anillo
 * `ink-500`, encendido `brand-600`, y su estado en palabras desde `sm`.
 */
function LiveSwitch({
  checked,
  disabled,
  pending,
  onChange,
  labelledBy,
  describedBy,
  label,
}: {
  checked: boolean;
  disabled: boolean;
  pending: boolean;
  onChange: (next: boolean) => void;
  labelledBy?: string;
  describedBy?: string;
  label?: string;
}) {
  const off = disabled || pending;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-label={label}
      aria-describedby={describedBy}
      aria-busy={pending || undefined}
      disabled={off}
      onClick={() => onChange(!checked)}
      className="group relative inline-flex shrink-0 items-center gap-2.5 rounded-full focus-visible:outline-none disabled:cursor-not-allowed pointer-coarse:min-h-11"
    >
      <span aria-hidden className={cn("hidden text-[13px] font-medium sm:inline", checked ? "text-ink-900" : "text-ink-500")}>
        {checked ? "Encendido" : "Apagado"}
      </span>
      <span
        aria-hidden
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full ring-1 ring-inset transition-[background-color,box-shadow] duration-150 motion-reduce:transition-none",
          "group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-brand-500",
          checked ? "bg-brand-600 ring-brand-600 group-enabled:group-hover:bg-brand-700" : "bg-white ring-ink-500 group-enabled:group-hover:bg-wash",
          off && "opacity-50",
        )}
      >
        <span
          className={cn(
            "absolute left-[3px] top-[3px] size-3.5 rounded-full transition-[transform,background-color] duration-150 motion-reduce:transition-none",
            checked ? "translate-x-4 bg-white shadow-control" : "bg-ink-500",
          )}
        />
      </span>
    </button>
  );
}

/** Debajo de un interruptor: guardando, guardado, el error o por qué está bloqueado. */
function RowStatus({ pending, status, blocked }: { pending: boolean; status: Status; blocked?: string | null }) {
  return (
    <div aria-live="polite" className="text-[13px] leading-5 empty:hidden">
      {pending ? (
        <span className="text-ink-500">Guardando…</span>
      ) : status ? (
        <span className={status.kind === "ok" ? "text-ok-fg" : "text-crit-fg"}>{status.text}</span>
      ) : blocked ? (
        <span className="text-warn-fg">{blocked}</span>
      ) : null}
    </div>
  );
}

/**
 * Encendido pero con su requisito apagado: el automático no hace nada. Se dice
 * en vez de dejar un «Encendido» que engaña (Chatby con la guía apagada no
 * confirma ningún pedido, MOM §40).
 */
function inertText(entry: AutomationEntry): string | null {
  return entry.requiresReason ? `Está encendido, pero no corre. ${entry.requiresReason}` : null;
}

function EffectBadge({ effect }: { effect: AutomationEffect }) {
  return <Badge tone={EFFECT_TONE[effect]}>{effect}</Badge>;
}

const LINK = "font-medium text-brand-700 hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center";

/** El enlace al detalle: una página, o los ajustes de cada tienda activa. */
function EntryLinks({ entry, stores }: { entry: AutomationEntry; stores: { id: string; name: string }[] }) {
  const link = entry.link;
  if (!link) return null;
  if (link.kind === "page") {
    return (
      <p className="mt-1.5 text-[13px]">
        <Link href={link.href} className={LINK}>
          {link.label}
        </Link>
      </p>
    );
  }
  if (stores.length === 0) return null;
  return (
    <p className="mt-1.5 flex flex-wrap gap-x-3 text-[13px]">
      {stores.map((s) => (
        <Link key={s.id} href={storeSettingsHref(s.id, link.section)} className={LINK}>
          Ajustes de {s.name}
        </Link>
      ))}
    </p>
  );
}

/** Nombre, chapa del efecto y lo que hace, a la izquierda de cada fila. */
function EntryHead({ entry, nameId, descId }: { entry: AutomationEntry; nameId: string; descId: string }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p id={nameId} className="text-sm font-semibold leading-5 text-ink-900">
          {entry.name}
        </p>
        <EffectBadge effect={entry.effect} />
      </div>
      <p id={descId} className={cn(HELP, "mt-0.5 max-w-[68ch]")}>
        {entry.what}
      </p>
    </>
  );
}

// ── Reintentos Aliclik en Lima ──────────────────────────────────────────────

function retryBadge(modes: Record<RetryVariant, RetryMode>, available: boolean): ReactNode {
  if (!available) return <Badge tone="warn">No instalado</Badge>;
  const active = RETRY_VARIANTS.filter((v) => modes[v] === "activo").length;
  const sim = RETRY_VARIANTS.filter((v) => modes[v] === "simulacion").length;
  if (!active && !sim) return <Badge>Todo apagado</Badge>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {active > 0 && <Badge tone="ok">{active === 1 ? "1 activo" : `${active} activos`}</Badge>}
      {sim > 0 && <Badge tone="info">{sim === 1 ? "1 en simulación" : `${sim} en simulación`}</Badge>}
    </span>
  );
}

function RetryGroup({ org, writable }: { org: AutomationsOrgView; writable: boolean }) {
  const retry = org.retry;
  const [modes, setModes] = useState(retry.modes);
  // Tras guardar, el servidor manda el estado nuevo: manda él.
  useEffect(() => setModes(retry.modes), [retry.modes]);
  const canEdit = writable && retry.available;

  return (
    <SettingsGroup
      title="Reintentos Aliclik en Lima"
      description="Los no entregados de Lima que vuelven a salir por Aliclik (AUTOECOM y luego ALIDRIVER). Cada paso de la cadena y cada motivo se enciende por separado."
    >
      <SettingsSection
        id="retry-variantes"
        title="Posición de cada reintento"
        badge={retryBadge(modes, retry.available)}
        description={
          <>
            <p>
              <strong>Apagado:</strong> la bandeja de Repro Lima lo sigue mostrando para aprobar a mano. <strong>Simulación:</strong> dice qué guía
              habría creado, sin crearla. <strong>Activo:</strong> crea la guía sola entre 8:00 a. m. y 2:00 p. m., otro día que el intento que falló.
            </p>
            <p>Conviene pasar cada fila por Simulación unos días y revisar «Hoy y ayer» antes de ponerla en Activo.</p>
          </>
        }
      >
        {retry.error && (
          <Banner tone="warn" role="status">
            {retry.error}
          </Banner>
        )}
        <RetryMatrix orgId={org.orgId} modes={modes} onSaved={(v, m) => setModes((prev) => ({ ...prev, [v]: m }))} canEdit={canEdit} />
      </SettingsSection>

      <SettingsSection
        id="retry-tope"
        title="Tope del día"
        badge={retry.available ? <Badge>{`Hoy: ${retry.countedToday} de ${retry.dailyCap}`}</Badge> : undefined}
        description="Cuántas guías automáticas pueden salir por día entre todas las tiendas. Al llegar al tope, lo que falta espera a mañana."
      >
        {/* Sin `key` del tope: guardar lo cambia, y remontar borraba el «Guardado». */}
        <CapCard orgId={org.orgId} cap={retry.dailyCap} canEdit={canEdit} />
      </SettingsSection>

      <GeocodeSection orgId={org.orgId} view={retry.geocode} writable={writable && retry.available} />

      <WhatsappLocationSection orgId={org.orgId} view={retry.chatbyAsk} writable={writable && retry.available} />

      <SimulateSection orgId={org.orgId} canEdit={canEdit} />

      <SettingsSection
        id="retry-registro"
        title="Hoy y ayer"
        badge={<Badge>{retry.log.length.toLocaleString("es-PE")}</Badge>}
        description="Lo que hizo o habría hecho cada pasada, un renglón por pedido. Lo más reciente primero."
      >
        <RetryLog rows={retry.log} />
      </SettingsSection>
    </SettingsGroup>
  );
}

const MODE_TEXT: Record<RetryMode, string> = {
  apagado: "text-ink-900",
  simulacion: "text-info-fg",
  activo: "text-brand-700",
};

/**
 * Control segmentado Apagado / Simulación / Activo (DESIGN.md › «Control
 * segmentado»): pista `wash` de 8 px con 2 px de relleno y la opción elegida
 * en blanco con sombra de control. Semántica de radio: una sola parada de
 * tabulador, las flechas mueven y eligen.
 *
 * El foco va con la decisión, no con la tecla: `onChange` dice si el cambio se
 * aceptó. Si se rechaza (confirmación cancelada, otra fila guardando) el foco
 * vuelve a la opción marcada; mientras esta fila guarda, se ignora. Y si el
 * guardado falla, el foco vuelve a la opción que sigue marcada. No se usa
 * `disabled` mientras guarda: quitarle el foco al botón lo tiraría al body.
 */
function ModeControl({
  value,
  label,
  disabled,
  pending,
  onChange,
}: {
  value: RetryMode;
  label: string;
  disabled: boolean;
  pending: boolean;
  onChange: (mode: RetryMode) => boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const checkedIndex = RETRY_MODES.indexOf(value);
  const focusChecked = () => refs.current[checkedIndex]?.focus();
  const choose = (i: number, moveFocus: boolean) => {
    if (pending) return;
    if (onChange(RETRY_MODES[i]!)) {
      if (moveFocus) refs.current[i]?.focus();
    } else focusChecked();
  };
  // Terminó de guardar: si el foco quedó en una opción que no es la marcada
  // (el guardado falló), vuelve a la marcada.
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending) {
      const focused = document.activeElement;
      const own = refs.current.some((b) => b === focused);
      if (own && focused !== refs.current[checkedIndex]) refs.current[checkedIndex]?.focus();
    }
    wasPending.current = pending;
  }, [pending, checkedIndex]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = RETRY_MODES.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = i === last ? 0 : i + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = i === 0 ? last : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next == null) return;
    e.preventDefault();
    choose(next, true);
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || pending || undefined}
      aria-busy={pending || undefined}
      className={cn("inline-flex rounded-lg bg-wash p-0.5 ring-1 ring-inset ring-line", pending && "opacity-60")}
    >
      {RETRY_MODES.map((mode, i) => {
        const on = mode === value;
        return (
          <button
            key={mode}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (!on) choose(i, false);
            }}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              "h-7 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 motion-reduce:transition-none",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-500 disabled:cursor-not-allowed pointer-coarse:h-11 pointer-coarse:px-3",
              on ? cn("bg-white shadow-control ring-1 ring-line", MODE_TEXT[mode]) : "text-ink-600 enabled:hover:text-ink-900",
            )}
          >
            {RETRY_MODE_LABEL[mode]}
          </button>
        );
      })}
    </div>
  );
}

function RetryMatrix({
  orgId,
  modes,
  onSaved,
  canEdit,
}: {
  orgId: string;
  modes: Record<RetryVariant, RetryMode>;
  onSaved: (variant: RetryVariant, mode: RetryMode) => void;
  canEdit: boolean;
}) {
  const [pendingVariant, setPendingVariant] = useState<RetryVariant | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [, startTransition] = useTransition();

  /** ¿Se aceptó el cambio? `ModeControl` mueve el foco solo si sí. */
  const change = (variant: RetryVariant, mode: RetryMode): boolean => {
    if (!canEdit || pendingVariant || modes[variant] === mode) return false;
    if (
      mode === "activo" &&
      !window.confirm(
        `¿Poner en Activo «${retryVariantLabel(variant)}»? Kapta creará guías de Aliclik de verdad, sin que nadie las apruebe, entre 8:00 a. m. y 2:00 p. m.`,
      )
    ) {
      return false;
    }
    setPendingVariant(variant);
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await setRetryVariantMode(orgId, variant, mode);
        if (!result.error) onSaved(variant, mode);
        const s = statusOf(result);
        setStatus(s && s.kind === "ok" ? { kind: "ok", text: `Guardado: ${retryVariantLabel(variant)} en ${RETRY_MODE_LABEL[mode]}.` } : s);
      } catch {
        setStatus({ kind: "error", text: NETWORK_ERROR });
      } finally {
        setPendingVariant(null);
      }
    });
    return true;
  };

  const control = (step: (typeof RETRY_STEPS)[number], reason: ChainReason) => {
    const variant = `${step.key}:${reason}` as RetryVariant;
    return (
      <ModeControl
        value={modes[variant]}
        label={`${step.label} · ${RETRY_REASON_LABEL[reason]}`}
        disabled={!canEdit}
        pending={pendingVariant === variant}
        onChange={(mode) => change(variant, mode)}
      />
    );
  };

  return (
    // La matriz depende del ancho de la TARJETA, no de la ventana: con el menú
    // abierto y el índice a la izquierda, entre 1024 y ~1375 px la tabla no
    // cabía y empujaba la página de lado. Tres controles de ~210 px más la
    // columna del paso piden unos 52rem; se muestra desde `@4xl` (56rem) de
    // tarjeta y, debajo, una tarjeta por paso.
    <div className={cn(CARD, "@container")}>
      {/* Desde `@4xl` de tarjeta: la matriz, pasos en filas y motivos en columnas. */}
      <div className="hidden overflow-x-auto @4xl:block">
        <table className="w-full text-sm">
          <caption className="sr-only">Posición de cada reintento, por paso de la cadena y motivo</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs font-semibold text-ink-600">
              <th scope="col" className="px-5 py-3">
                Paso de la cadena
              </th>
              {CHAIN_REASONS.map((reason) => (
                <th key={reason} scope="col" className="px-3 py-3">
                  {RETRY_REASON_LABEL[reason]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {RETRY_STEPS.map((step) => (
              <tr key={step.key}>
                <th scope="row" className="px-5 py-4 text-left align-top font-normal">
                  <span className="block font-semibold text-ink-900">{step.label}</span>
                  <span className={cn(HELP, "mt-0.5 block max-w-[34ch]")}>{step.hint}</span>
                </th>
                {CHAIN_REASONS.map((reason) => (
                  <td key={reason} className="px-3 py-4 align-top">
                    {control(step, reason)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Con la tarjeta más angosta (teléfono, tableta o escritorio con menú): una tarjeta por paso, un motivo por fila. */}
      <ul className="divide-y divide-line @4xl:hidden">
        {RETRY_STEPS.map((step) => (
          <li key={step.key} className={ROW}>
            <p className="text-sm font-semibold text-ink-900">{step.label}</p>
            <p className={cn(HELP, "mt-0.5")}>{step.hint}</p>
            <dl className="mt-3 space-y-2.5">
              {CHAIN_REASONS.map((reason) => (
                <div key={reason} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                  <dt className="text-[13px] font-medium text-ink-700">{RETRY_REASON_LABEL[reason]}</dt>
                  <dd>{control(step, reason)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>

      {(pendingVariant || status) && (
        <div className={cn(ROW, "border-t border-line py-3")}>
          <RowStatus pending={!!pendingVariant} status={status} />
        </div>
      )}
    </div>
  );
}

function CapCard({ orgId, cap, canEdit }: { orgId: string; cap: number; canEdit: boolean }) {
  const id = useId();
  const [value, setValue] = useState(String(cap));
  // Lo último guardado: el tope del servidor o lo que esta tarjeta acaba de
  // guardar. «Sin guardar» se mide contra esto, no contra la prop, que llega
  // un momento después de guardar.
  const [saved, setSaved] = useState(String(cap));
  const [seenCap, setSeenCap] = useState(cap);
  const [status, setStatus] = useState<Status>(null);
  const [pending, startTransition] = useTransition();
  const dirty = value !== saved;
  // El tope cambió en el servidor (otra pestaña, otra persona, o este mismo
  // guardado): se adopta si aquí no hay nada a medias. Ajuste durante el
  // render, sin remontar la tarjeta, para que «Guardado» siga a la vista.
  if (cap !== seenCap) {
    setSeenCap(cap);
    if (!pending && !dirty) {
      setSaved(String(cap));
      setValue(String(cap));
    }
  }

  return (
    <form
      className={CARD}
      onSubmit={(e) => {
        e.preventDefault();
        if (!canEdit || pending) return;
        const submitted = value;
        setStatus(null);
        startTransition(async () => {
          try {
            const result = await setRetryDailyCap(orgId, submitted);
            if (!result.error) {
              const normalized = String(Number(submitted));
              setSaved(normalized);
              setValue((current) => (current === submitted ? normalized : current));
            }
            setStatus(statusOf(result));
          } catch {
            setStatus({ kind: "error", text: NETWORK_ERROR });
          }
        });
      }}
    >
      <div className={ROW}>
        <label htmlFor={id} className="text-[13px] font-medium leading-5 text-ink-700">
          Guías automáticas por día
        </label>
        <div className="mt-1.5 flex items-center gap-2">
          <input
            id={id}
            type="number"
            inputMode="numeric"
            min={RETRY_DAILY_CAP_MIN}
            max={RETRY_DAILY_CAP_MAX}
            step={1}
            required
            value={value}
            disabled={!canEdit}
            onChange={(e) => {
              setValue(e.target.value);
              setStatus(null);
            }}
            aria-describedby={`${id}-hint`}
            className={cn(NUMBER_NARROW, "h-9 w-24 px-3 pointer-coarse:h-11")}
          />
          <span className="text-sm text-ink-500">al día</span>
        </div>
        <p id={`${id}-hint`} className={cn(HELP, "mt-1.5")}>
          De {RETRY_DAILY_CAP_MIN} a {RETRY_DAILY_CAP_MAX}. Cuentan las guías creadas y las que Aliclik pudo haber creado sin responder.
        </p>
      </div>
      <div className={cn(ROW, "flex flex-wrap items-center justify-end gap-3 border-t border-line py-3")}>
        <div aria-live="polite" className="text-[13px]">
          {pending ? (
            <span className="text-ink-500">Guardando…</span>
          ) : status ? (
            <span className={status.kind === "ok" ? "text-ok-fg" : "text-crit-fg"}>{status.text}</span>
          ) : dirty ? (
            <span className="text-ink-500">Cambios sin guardar</span>
          ) : null}
        </div>
        <OpsButton type="submit" variant="primary" disabled={!canEdit || pending || !dirty} className="pointer-coarse:h-11">
          Guardar
        </OpsButton>
      </div>
    </form>
  );
}

function SimulateSection({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const [result, setResult] = useState<RetrySimulationResult | null>(null);
  const [pending, startTransition] = useTransition();
  const sim = result?.simulation;

  return (
    <SettingsSection
      id="retry-simular"
      title="Simular ahora"
      description="Revisa ahora los pedidos listos para reintentar y dice qué guía saldría, sin crear ninguna. Mira todos los pasos, también los apagados. Consulta a Aliclik, así que puede tardar. Con la ubicación por dirección encendida, también busca en Google la dirección de los pedidos sin coordenada y guarda esa respuesta (una vez por pedido), para que la pasada no la vuelva a pedir."
      actions={
        <OpsButton
          size="sm"
          disabled={!canEdit || pending}
          onClick={() => {
            setResult(null);
            startTransition(async () => {
              try {
                setResult(await simulateRetriesNow(orgId));
              } catch {
                // La función se cortó o se perdió la conexión: un aviso, no el límite de errores.
                setResult({ error: "La simulación no respondió: se cortó o se perdió la conexión. Vuelve a intentar." });
              }
            });
          }}
          className="pointer-coarse:h-11"
        >
          {pending ? "Simulando…" : "Simular ahora"}
        </OpsButton>
      }
    >
      <div aria-live="polite" className="space-y-3 empty:hidden">
        {result?.error && (
          <Banner tone="crit" role="alert">
            {result.error}
          </Banner>
        )}
        {sim && (
          <>
            {sim.skipped && <Banner tone="info">La pasada no revisó pedidos esta vez.</Banner>}
            {sim.stopped && <Banner tone="warn">La simulación se cortó por tiempo: muestra lo evaluado. Los pedidos que faltan los revisa la pasada siguiente.</Banner>}
            <div className={CARD}>
              <div className={cn(ROW, "border-b border-line py-3 text-[13px] text-ink-600")}>
                Quedan <span className="font-semibold tabular-nums text-ink-900">{sim.capLeft}</span> de{" "}
                <span className="tabular-nums">{sim.dailyCap}</span> guías para hoy.
              </div>
              {sim.items.length === 0 ? (
                <p className={cn(ROW, "text-sm text-ink-500")}>{result?.notice ?? "Ningún pedido está listo para reintentar ahora."}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {sim.items.map((item) => (
                    <li key={item.orderId} className={cn(ROW, "py-3")}>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <Link href={`/dashboard/pedidos?abrir=${item.orderId}`} className={cn(LINK, "text-sm font-semibold")}>
                          {item.orderName}
                        </Link>
                        <Badge tone={item.outcome ? (OUTCOME_TONE[item.outcome] ?? "neutral") : "neutral"} wrap>
                          {item.outcomeLabel}
                        </Badge>
                        {item.transport && <span className="text-[13px] text-ink-600">{item.transport}</span>}
                      </div>
                      <p className={cn(HELP, "mt-0.5")}>
                        {item.variantLabel} · ahora: {item.modeLabel}
                      </p>
                      {item.detail && <p className={cn(HELP, "mt-0.5")}>{item.detail}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  );
}

// ── La «Lista negra» automática (0326, MOM §41.11; textos de lib/lista-negra-copy.ts) ───────────────

function pagoOnlineBadge(mode: PagoOnlineMode, available: boolean): ReactNode {
  if (!available) return <Badge tone="warn">No instalado</Badge>;
  if (mode === "activo") return <Badge tone="ok">Activo</Badge>;
  if (mode === "simulacion") return <Badge tone="info">En simulación</Badge>;
  return <Badge>Apagado</Badge>;
}

const GUARD_LABEL: Record<string, string> = {
  primera: "Primera lista: sin comparación",
  ok: "Pasó el freno de cambio brusco",
  bloqueado: "Frenada por cambio brusco",
  aceptado: "Aceptada a mano pese al cambio brusco",
};

function PagoOnlineRunCard({ title, run }: { title: string; run: PagoOnlineRunView }) {
  return (
    <div className={CARD}>
      <div className={cn(ROW, "space-y-1.5")}>
        <p className="text-sm font-semibold text-ink-900">{title}</p>
        {run.status === "error" ? (
          <p className="text-[13px] text-crit-fg">{run.error ?? "El cálculo falló."}</p>
        ) : (
          <>
            <p className="text-sm text-ink-700">
              {run.mode === "activo" ? "La lista tiene" : "La lista tendría"} <strong>{fmtInt(run.phones)}</strong> celulares
              {run.emails ? ` y ${fmtInt(run.emails)} correos` : ""}: {fmtInt(Math.max(0, run.phones - run.anuladores - run.rechazos))} con un pedido devuelto (
              {fmtInt(run.twoOrMore)} con 2 o más), {fmtInt(run.rechazos)} que rechazaron un pedido en la puerta y {fmtInt(run.anuladores)} que anularon el 75 % o más de 5 o más pedidos
              {run.excepted ? ` · ${fmtInt(run.excepted)} exceptuados por Kapta (no van)` : ""}.
            </p>
            <p className={HELP}>
              En Por confirmar hay {fmtInt(run.porConfirmarListed)} pedidos de estos clientes; con «{PAGO_ONLINE_REQUIREMENT_LABEL[run.requirement]}», hoy
              {run.mode === "activo" ? " se frenan " : " se frenarían "}
              {fmtInt(run.porConfirmarBraked)}.{" "}
              {run.guard ? `${GUARD_LABEL[run.guard] ?? run.guard}${run.baseline != null ? ` (la anterior tenía ${fmtInt(run.baseline)})` : ""}.` : ""}
              {run.acceptedBy ? ` Aceptada por ${run.acceptedBy}.` : ""}
            </p>
            {run.guardReason && <p className="text-[13px] text-warn-fg">{run.guardReason}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function PagoOnlineGroup({ org, writable }: { org: AutomationsOrgView; writable: boolean }) {
  const view = org.pagoOnline;
  const [mode, setMode] = useState<PagoOnlineMode>(view.mode);
  useEffect(() => setMode(view.mode), [view.mode]);
  const [requirement, setRequirement] = useState<PagoOnlineRequirement>(view.requirement);
  useEffect(() => setRequirement(view.requirement), [view.requirement]);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [runStatus, setRunStatus] = useState<Status>(null);
  const [runPending, startRun] = useTransition();
  const [testStore, setTestStore] = useState(view.stores[0]?.id ?? "");
  const [testPhone, setTestPhone] = useState("");
  const [testStatus, setTestStatus] = useState<Status>(null);
  const [testPending, startTest] = useTransition();
  const [excStatus, setExcStatus] = useState<Status>(null);
  const [, startTransition] = useTransition();
  const canEdit = writable && view.available;

  const save = (fn: () => Promise<AutomationActionResult>, onOk: () => void) => {
    setPending(true);
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await fn();
        if (!result.error) onOk();
        setStatus(result.error ? { kind: "error", text: result.error } : { kind: "ok", text: result.notice ?? "Guardado" });
      } catch {
        setStatus({ kind: "error", text: NETWORK_ERROR });
      } finally {
        setPending(false);
      }
    });
  };

  const changeMode = (next: RetryMode): boolean => {
    if (!canEdit || pending || next === mode) return false;
    if (
      next === "activo" &&
      !window.confirm(
        `¿Poner en Activo «${PAGO_ONLINE_LABEL}»? Cada día a las 05:00 de Lima Kapta manda la lista a cada tienda (que deja de ofrecerles contra entrega) y frena en Kapta la confirmación y las guías contra entrega de esos clientes hasta tener ${lnMotivoInline(PAGO_ONLINE_REQUIREMENT_LABEL[requirement])} validado.`,
      )
    ) {
      return false;
    }
    save(() => setPagoOnlineMode(org.orgId, next), () => setMode(next as PagoOnlineMode));
    return true;
  };

  const run = view.lastRun;
  return (
    <SettingsGroup
      title={LN_PANEL_TITLE}
      description="Los clientes que nunca recibieron un pedido contra entrega y tienen uno devuelto, rechazaron uno en la puerta o anularon el 75 % o más de 5 o más pedidos (Kenku y Aurela juntas, todo el historial, sin los artefactos de la migración de plataforma): las tiendas no les ofrecen contra entrega y Kapta frena sus pedidos contra entrega. Nunca se muestran los celulares."
    >
      <SettingsSection
        id="pago-online-posicion"
        title="Posición y cobro"
        badge={pagoOnlineBadge(mode, view.available)}
        description={
          <>
            <p>
              <strong>Apagado:</strong> no calcula, no manda y no frena. <strong>Simulación:</strong> cada día a las 05:00 de Lima calcula la lista y
              dice cuántos serían y cuántos pedidos frenaría, sin mandar nada ni frenar nada. <strong>Activo:</strong> además la manda entera a cada
              tienda (reemplaza la anterior) y frena en Kapta.
            </p>
            <p>
              En los pedidos de Kapta (asesoras, Chatby, el bot) el cliente de la lista paga <strong>{PAGO_ONLINE_REQUIREMENT_LABEL.adelanto}</strong>{" "}
              —el adelanto validado de la escalera del §8— o <strong>{PAGO_ONLINE_REQUIREMENT_LABEL.pago_completo}</strong>. El owner eligió el adelanto
              (09-11-2026).
            </p>
            <p>
              La lista se ve, se busca por celular y se completa a mano en{" "}
              <Link href={PREPAY_LIST_PATH} className={cn(LINK, "text-[13px]")}>
                {LN_NAME}
              </Link>
              . El envío diario a las tiendas lleva también las altas a mano.
            </p>
          </>
        }
      >
        {view.error && (
          <Banner tone="warn" role="status">
            {view.error}
          </Banner>
        )}
        <div className={CARD}>
          <div className={cn(ROW, "flex flex-wrap items-center justify-between gap-3")}>
            <span className="text-sm font-medium text-ink-900">Posición</span>
            <ModeControl value={mode as RetryMode} label={PAGO_ONLINE_LABEL} disabled={!canEdit} pending={pending} onChange={changeMode} />
          </div>
          <div className={cn(ROW, "flex flex-wrap items-center justify-between gap-3 border-t border-line")}>
            <label htmlFor="pago-online-cobro" className="text-sm font-medium text-ink-900">
              {LN_PANEL_REQUIREMENT_LABEL}
            </label>
            <select
              id="pago-online-cobro"
              value={requirement}
              disabled={!canEdit || pending}
              onChange={(e) => {
                const next = e.target.value as PagoOnlineRequirement;
                if (next === requirement) return;
                save(() => setPagoOnlineRequirement(org.orgId, next), () => setRequirement(next));
              }}
              className="block h-9 rounded-md border-0 bg-white px-3 text-sm text-ink-900 shadow-control ring-1 ring-inset ring-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60 pointer-coarse:h-11"
            >
              {PAGO_ONLINE_REQUIREMENTS.map((r) => (
                <option key={r} value={r}>
                  {PAGO_ONLINE_REQUIREMENT_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
          <div className={cn(ROW, "border-t border-line text-[13px] text-ink-600")}>
            {view.current
              ? `La lista que frena hoy en Kapta: ${fmtInt(view.current.phones)} celulares, calculada el ${view.current.at}.`
              : "Todavía no hay una lista vigente: Kapta no frena por esta regla."}
          </div>
          {(pending || status) && (
            <div className={cn(ROW, "border-t border-line py-3")}>
              <RowStatus pending={pending} status={status} />
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        id="pago-online-tiendas"
        title="Envío a las tiendas"
        description="Por tienda: el último envío bueno (con lo que dice el GET de la tienda), el último error y el freno de cambio brusco (más del doble o menos de la mitad que la anterior: no se manda y se avisa por Telegram). Reintenta a los 1, 5 y 15 minutos si la tienda no responde; nunca con claves rechazadas. Un 404 es que la tienda aún no tiene cod-core 0.10.45."
        actions={
          <OpsButton
            size="sm"
            disabled={!canEdit || runPending || mode === "apagado"}
            onClick={() => {
              if (mode === "activo" && !window.confirm("¿Calcular la lista ahora y mandarla a cada tienda? Reemplaza la lista automática de cada una.")) return;
              setRunStatus(null);
              startRun(async () => {
                try {
                  const r = await runPagoOnlineNow(org.orgId);
                  setRunStatus(r.error ? { kind: "error", text: r.error } : { kind: "ok", text: r.notice ?? "Listo" });
                } catch {
                  setRunStatus({ kind: "error", text: "No respondió: se cortó o se perdió la conexión. Vuelve a intentar." });
                }
              });
            }}
            className="pointer-coarse:h-11"
          >
            {runPending ? "Calculando…" : "Calcular ahora"}
          </OpsButton>
        }
      >
        <div aria-live="polite" className="empty:hidden">
          {runStatus && (
            <Banner tone={runStatus.kind === "ok" ? "info" : "crit"} role={runStatus.kind === "ok" ? "status" : "alert"}>
              {runStatus.text}
            </Banner>
          )}
        </div>
        {run ? (
          <PagoOnlineRunCard title={`Última corrida · ${run.at} · ${run.mode === "activo" ? "Activo" : "Simulación"}${run.trigger === "manual" ? " · a mano" : ""}`} run={run} />
        ) : (
          <p className={cn(CARD, ROW, "text-sm text-ink-500")}>Todavía no hay ninguna corrida.</p>
        )}
        {run?.canAccept && (
          <div className={cn(CARD, ROW, "flex flex-wrap items-center justify-between gap-3")}>
            <p className="text-[13px] text-ink-700">Si el cambio es correcto (por ejemplo, cambió la regla), acéptala: pasa a frenar en Kapta y se manda a cada tienda.</p>
            <OpsButton
              size="sm"
              disabled={!canEdit || runPending}
              onClick={() => {
                if (!window.confirm("¿Aceptar la lista de hoy pese al cambio brusco y mandarla a cada tienda?")) return;
                setRunStatus(null);
                startRun(async () => {
                  try {
                    const r = await acceptPagoOnlineList(org.orgId, run.id);
                    setRunStatus(r.error ? { kind: "error", text: r.error } : { kind: "ok", text: r.notice ?? "Aceptada" });
                  } catch {
                    setRunStatus({ kind: "error", text: NETWORK_ERROR });
                  }
                });
              }}
              className="pointer-coarse:h-11"
            >
              Aceptar la lista de hoy
            </OpsButton>
          </div>
        )}
        {view.lastSimulation && <PagoOnlineRunCard title={`Última simulación · ${view.lastSimulation.at}`} run={view.lastSimulation} />}
        {view.stores.length === 0 ? (
          <p className={cn(CARD, ROW, "text-sm text-ink-500")}>No hay tiendas WooCommerce activas en esta organización.</p>
        ) : (
          <div className={CARD}>
            {view.stores.map((s, i) => (
              <div key={s.id} className={cn(ROW, "space-y-1", i > 0 && "border-t border-line")}>
                <p className="text-sm font-semibold text-ink-900">{s.name}</p>
                <p className="text-[13px] text-ink-700">
                  {s.lastOk
                    ? `Último envío bueno: ${s.lastOk.at} · ${fmtInt(s.lastOk.phones)} celulares${s.lastOk.emails ? ` y ${fmtInt(s.lastOk.emails)} correos` : ""}${
                        s.lastOk.verifyPhones != null ? ` · la tienda dice ${fmtInt(s.lastOk.verifyPhones)}${s.lastOk.verifyUpdatedAt ? ` (${s.lastOk.verifyUpdatedAt})` : ""}` : ""
                      }${s.lastOk.verifyError ? ` · el GET falló: ${s.lastOk.verifyError}` : ""}`
                    : "Todavía no recibió ninguna lista."}
                </p>
                {s.lastError && (
                  <p className="text-[13px] text-crit-fg">
                    Último error: {s.lastError.at} · {s.lastError.status}
                    {s.lastError.httpStatus ? ` (HTTP ${s.lastError.httpStatus})` : ""}
                    {s.lastError.error ? ` · ${s.lastError.error}` : ""}
                  </p>
                )}
                {s.guard && (
                  <p className="text-[13px] text-warn-fg">
                    Freno de cambio brusco: {s.guard.at}
                    {s.guard.reason ? ` · ${s.guard.reason}` : ""}
                  </p>
                )}
                {s.lastTest && (
                  <p className={HELP}>
                    Última prueba: {s.lastTest.at} · {s.lastTest.status}
                    {s.lastTest.verifyPhones != null ? ` · la tienda dice ${fmtInt(s.lastTest.verifyPhones)}` : ""}
                  </p>
                )}
                <div className="pt-1">
                  <OpsButton
                    size="sm"
                    variant="danger"
                    disabled={!canEdit || runPending}
                    onClick={() => {
                      if (
                        !window.confirm(
                          `¿Vaciar la lista automática de ${s.name}? La tienda dejará de frenar el contra entrega de TODOS los clientes de la lista automática hasta el próximo envío.${
                            mode === "apagado" ? " Con la automatización en Apagado, no se vuelve a llenar sola." : " El envío diario de las 05:00 de Lima la vuelve a llenar, salvo que pongas la automatización en Apagado."
                          } La lista manual de la tienda no cambia.`,
                        )
                      )
                        return;
                      setRunStatus(null);
                      startRun(async () => {
                        try {
                          const r = await emptyPagoOnlineStoreList(org.orgId, s.id);
                          setRunStatus(r.error ? { kind: "error", text: r.error } : { kind: "ok", text: r.notice ?? "Vaciada" });
                        } catch {
                          setRunStatus({ kind: "error", text: NETWORK_ERROR });
                        }
                      });
                    }}
                    className="pointer-coarse:h-11"
                  >
                    Vaciar la lista de la tienda
                  </OpsButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        id="pago-online-prueba"
        title="Enviar prueba"
        description="La prueba del §6 del pedido de las tiendas: manda a UNA tienda una lista con un solo celular del equipo («regla: prueba») y la verifica con el GET. Ojo: la tienda reemplaza su lista automática por ese celular hasta el próximo envío real. El celular no se guarda. Funciona en cualquier posición."
      >
        <div className={CARD}>
          <div className={cn(ROW, "flex flex-wrap items-center gap-2")}>
            <select
              value={testStore}
              onChange={(e) => setTestStore(e.target.value)}
              aria-label="Tienda de la prueba"
              disabled={!canEdit || testPending}
              className="block h-9 rounded-md border-0 bg-white px-3 text-sm text-ink-900 shadow-control ring-1 ring-inset ring-line-strong disabled:opacity-60 pointer-coarse:h-11"
            >
              {view.stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <input
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              inputMode="tel"
              autoComplete="off"
              placeholder="Celular del equipo"
              aria-label="Celular del equipo"
              disabled={!canEdit || testPending}
              className="h-9 w-44 rounded-md bg-white px-3 text-sm text-ink-900 ring-1 ring-inset ring-line-strong disabled:opacity-60 pointer-coarse:h-11"
            />
            <OpsButton
              size="sm"
              disabled={!canEdit || testPending || !testStore || testPhone.replace(/\D/g, "").length < 9}
              onClick={() => {
                const name = view.stores.find((s) => s.id === testStore)?.name ?? "la tienda";
                if (!window.confirm(`¿Mandar la prueba a ${name}? Su lista automática queda con ese único celular hasta el próximo envío real.`)) return;
                setTestStatus(null);
                startTest(async () => {
                  try {
                    const r = await sendPagoOnlineTestList(org.orgId, testStore, testPhone);
                    setTestStatus(r.error ? { kind: "error", text: r.error } : { kind: "ok", text: r.notice ?? "Enviada" });
                    if (!r.error) setTestPhone("");
                  } catch {
                    setTestStatus({ kind: "error", text: NETWORK_ERROR });
                  }
                });
              }}
              className="pointer-coarse:h-11"
            >
              {testPending ? "Enviando…" : "Enviar prueba"}
            </OpsButton>
          </div>
          {testStatus && (
            <div className={cn(ROW, "border-t border-line py-3")}>
              <RowStatus pending={false} status={testStatus} />
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        id="pago-online-excepciones"
        title="Excepciones de Kapta"
        description="Clientes que no entran a la lista aunque cumplan la regla. Se agregan desde la ficha del pedido o la página «Lista negra» («Exceptuar de la Lista negra», con motivo). Kapta deja de frenarlos al momento; las tiendas, desde el próximo envío. Las tiendas tienen además las suyas («-987654321» en su panel)."
      >
        {excStatus && <RowStatus pending={false} status={excStatus} />}
        {view.exceptions.length === 0 ? (
          <p className={cn(CARD, ROW, "text-sm text-ink-500")}>{LN_EMPTY_EXCEPTIONS}</p>
        ) : (
          <div className={CARD}>
            {view.exceptions.map((e, i) => (
              <div key={e.id} className={cn(ROW, "flex flex-wrap items-center justify-between gap-3", i > 0 && "border-t border-line")}>
                <div className="min-w-0">
                  <p className="text-sm text-ink-900">
                    <span className="tabular-nums">{e.phoneMasked}</span>
                    {e.orderName ? ` · ${e.orderName}` : ""}
                  </p>
                  <p className={HELP}>
                    {e.reason} · {e.addedBy} · {e.addedAt}
                  </p>
                </div>
                <OpsButton
                  size="sm"
                  disabled={!canEdit}
                  onClick={() => {
                    const reason = window.prompt("¿Por qué se quita la excepción? (al menos 8 caracteres)") ?? "";
                    if (!reason.trim()) return;
                    setExcStatus(null);
                    startTransition(async () => {
                      try {
                        const r = await removePagoOnlineExceptionAction(org.orgId, e.id, reason);
                        setExcStatus(r.error ? { kind: "error", text: r.error } : { kind: "ok", text: r.notice ?? "Quitada" });
                      } catch {
                        setExcStatus({ kind: "error", text: NETWORK_ERROR });
                      }
                    });
                  }}
                  className="pointer-coarse:h-11"
                >
                  {LN_EXCEPTION_REMOVE}
                </OpsButton>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsGroup>
  );
}

// ── La ubicación por dirección (Google) en los reintentos (0308) ────────────

const fmtPct = (v: number | null) => (v == null ? "—" : `${v.toLocaleString("es-PE", { maximumFractionDigits: 1 })} %`);
const fmtInt = (v: number) => v.toLocaleString("es-PE");

/** Una medición de Lima: solo cuentas, y si deja encender el interruptor. */
function LimaRunCard({ title, summary }: { title: string; summary: GeocodeLimaRunSummary }) {
  const gate = geocodeLimaGate(summary);
  const reasons = (Object.keys(GEOCODE_REASON_LABEL) as GeocodePilotReason[]).filter((r) => (summary.rejections[r] ?? 0) > 0);
  const stat = (label: string, value: string) => (
    <div className="min-w-0">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums text-ink-900">{value}</dd>
    </div>
  );
  return (
    <div className={CARD}>
      <div className={cn(ROW, "flex flex-wrap items-center justify-between gap-2 border-b border-line py-3")}>
        <p className="text-[13px] font-medium text-ink-700">{title}</p>
        {gate.ok ? <Badge tone="ok">Cumple el criterio B</Badge> : <Badge tone="warn">No cumple el criterio B</Badge>}
      </div>
      <dl className={cn(ROW, "grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4")}>
        {stat("Pedidos de Lima medidos", fmtInt(summary.sampled))}
        {stat("Pasan el candado", fmtInt(summary.passed))}
        {stat("Con el edificio (ROOFTOP)", fmtInt(summary.rooftop))}
        {stat("Mediana al pin", summary.medianM == null ? "—" : `${fmtInt(Math.round(summary.medianM))} m`)}
        {stat(`A ${GEOCODE_CRITERION_B.withinMeters} m o menos`, fmtPct(summary.within300Pct))}
        {stat("A más de 1 km", fmtPct(summary.beyond1kmPct))}
        {stat(`Solo edificio, a ${GEOCODE_CRITERION_B.withinMeters} m o menos`, fmtPct(summary.rooftopWithin300Pct))}
        {stat("Consultas a Google", fmtInt(summary.apiCalls))}
      </dl>
      <div className={cn(ROW, "space-y-1 border-t border-line py-3")}>
        <p className={HELP}>
          Para encender hace falta que al menos el {GEOCODE_CRITERION_B.minShare * 100} % de los puntos con el edificio quede a{" "}
          {GEOCODE_CRITERION_B.withinMeters} m o menos del pin que puso una persona, con al menos {GEOCODE_LIMA_MIN_ROOFTOP} puntos.
        </p>
        {!gate.ok && <p className="text-[13px] text-warn-fg">{gate.reason}</p>}
        {summary.truncated && <p className={HELP}>Se cortó por tiempo antes de consultar toda la muestra.</p>}
        {summary.quotaHit && <p className={HELP}>Google cortó por el cupo diario: lo que faltó no se consultó.</p>}
        {reasons.length > 0 && (
          <p className={HELP}>
            No pasaron: {reasons.map((r) => `${GEOCODE_REASON_LABEL[r].toLowerCase()} (${fmtInt(summary.rejections[r] ?? 0)})`).join(" · ")}.
          </p>
        )}
      </div>
    </div>
  );
}

function GeocodeSection({ orgId, view, writable }: { orgId: string; view: RetryGeocodeView; writable: boolean }) {
  const id = useId();
  const [checked, setChecked] = useState(view.enabled);
  useEffect(() => setChecked(view.enabled), [view.enabled]);
  const [status, setStatus] = useState<Status>(null);
  const [pending, startTransition] = useTransition();
  const [measure, setMeasure] = useState<LimaGeocodeMeasureResult | null>(null);
  const [measuring, startMeasure] = useTransition();
  const canEdit = writable && view.available;
  // Apagar se puede siempre; encender, solo con la clave y una medición de Lima que cumpla B.
  const disabled = !canEdit || (!checked && !!view.blocked);
  const blocked = view.error ?? (view.blocked ? (checked ? `Está encendido, pero no se usa: ${view.blocked}` : view.blocked) : null);

  const toggle = (next: boolean) => {
    if (pending) return;
    if (
      next &&
      !window.confirm(
        "¿Usar la ubicación por dirección (Google) en los reintentos de Lima? Cuando un pedido no tenga coordenada, Kapta buscará su dirección en Google y, si da el edificio, cotizará y creará la guía de Aliclik con ese punto, sin que una persona lo mire.",
      )
    ) {
      return;
    }
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await setRetryGeocode(orgId, next);
        if (!result.error) setChecked(next);
        setStatus(statusOf(result));
      } catch {
        setStatus({ kind: "error", text: NETWORK_ERROR });
      }
    });
  };

  return (
    <SettingsSection
      id="retry-ubicacion"
      title="Ubicación por dirección (Google)"
      badge={!view.available ? <Badge tone="warn">No instalado</Badge> : checked ? <Badge tone="ok">Encendida</Badge> : <Badge>Apagada</Badge>}
      description={
        <>
          <p>
            Aliclik exige la coordenada y casi ningún pedido de WooCommerce en Lima la trae. Sin ella, el reintento queda «Sin ubicación: falta la
            coordenada»: se vuelve a mirar en la pasada siguiente, no cuenta para el tope, no avisa y sigue en la bandeja hasta que una persona pone la
            ubicación en la ficha del pedido («Corregir ubicación»).
          </p>
          <p>
            Encendida, la pasada busca la dirección en Google una vez por pedido y solo usa el punto si Google da el edificio. Antes hay que medir Lima:
            solo se enciende si la última medición cumple el criterio B.
          </p>
        </>
      }
    >
      <div className={CARD}>
        <div className={ROW}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p id={`${id}-name`} className="text-sm font-semibold leading-5 text-ink-900">
                Usar la ubicación por dirección (Google) si el pedido no tiene
              </p>
              <p id={`${id}-desc`} className={cn(HELP, "mt-0.5 max-w-[68ch]")}>
                En Simulación y Activo, y en «Simular ahora» del panel. El log y el hecho de la aprobación dicen que la coordenada vino de Google. Si
                el pedido no respalda el punto de Google, queda para una persona.
              </p>
            </div>
            <LiveSwitch
              checked={checked}
              disabled={disabled}
              pending={pending}
              onChange={toggle}
              labelledBy={`${id}-name`}
              describedBy={`${id}-desc`}
            />
          </div>
          <div className="mt-1.5">
            <RowStatus pending={pending} status={status} blocked={blocked} />
          </div>
        </div>
        <div className={cn(ROW, "flex flex-wrap items-center justify-between gap-3 border-t border-line py-3")}>
          <p className={cn(HELP, "max-w-[60ch]")}>
            Mide solo Lima, con los pedidos de WooCommerce de los últimos 7 días que ya tienen el pin de una persona (no el punto de Google de una guía
            automática), entre todas las tiendas. Hasta {GEOCODE_LIMA_CAP} consultas a Google por día, sumando las mediciones de hoy, para que el cupo
            del día (400) siga alcanzando para Chatby. Guarda solo las cuentas.
          </p>
          <OpsButton
            size="sm"
            disabled={!canEdit || !view.keyPresent || measuring}
            onClick={() => {
              if (
                !window.confirm(
                  `¿Medir ahora? Kapta consultará en Google hasta ${GEOCODE_LIMA_CAP} direcciones de Lima, del cupo diario de 400 que también usa Chatby.`,
                )
              ) {
                return;
              }
              setMeasure(null);
              startMeasure(async () => {
                try {
                  setMeasure(await measureLimaGeocodeNow(orgId));
                } catch {
                  setMeasure({ error: "La medición no respondió: se cortó o se perdió la conexión. Vuelve a intentar." });
                }
              });
            }}
            className="pointer-coarse:h-11"
          >
            {measuring ? "Midiendo…" : "Medir la ubicación por dirección en Lima"}
          </OpsButton>
        </div>
      </div>

      <div aria-live="polite" className="space-y-3 empty:hidden">
        {measure?.error && (
          <Banner tone="crit" role="alert">
            {measure.error}
          </Banner>
        )}
        {measure?.notice && (
          <Banner tone="warn" role="status">
            {measure.notice}
          </Banner>
        )}
        {measure?.summary && <LimaRunCard title="Resultado de esta medición" summary={measure.summary} />}
      </div>

      {!measure?.summary &&
        (view.latest?.summary ? (
          <LimaRunCard title={`Última medición de Lima: ${view.latest.at}`} summary={view.latest.summary} />
        ) : view.available ? (
          <div className={CARD}>
            <p className={cn(ROW, "text-sm text-ink-500")}>
              {view.latest ? `La medición del ${view.latest.at} no se pudo leer.` : "Todavía no se midió Lima."}
            </p>
          </div>
        ) : null)}
    </SettingsSection>
  );
}

function ModeBadge({ mode }: { mode: RetryLogView["mode"] }) {
  return mode === "activo" ? <Badge tone="brand">Activo</Badge> : <Badge tone="info">Simulación</Badge>;
}

function RetryLog({ rows }: { rows: RetryLogView[] }) {
  if (rows.length === 0) {
    return (
      <div className={CARD}>
        <p className={cn(ROW, "text-sm text-ink-500")}>Hoy y ayer no hubo pasadas con reintentos en Simulación ni en Activo.</p>
      </div>
    );
  }
  const outcome = (r: RetryLogView) => (
    <Badge tone={r.outcome ? (OUTCOME_TONE[r.outcome] ?? "neutral") : "neutral"} wrap>
      {r.outcomeLabel}
    </Badge>
  );
  const order = (r: RetryLogView) => (
    <Link href={`/dashboard/pedidos?abrir=${r.orderId}`} className={cn(LINK, "font-semibold")}>
      {r.orderName}
    </Link>
  );
  return (
    <div className={CARD}>
      {/* Desde `md`, tabla con cabecera pegajosa y su propio desplazamiento. */}
      <div className="hidden max-h-[60vh] overflow-y-auto md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">Lo que hicieron las pasadas de hoy y ayer</caption>
          <thead className="sticky top-0 z-10 bg-white shadow-[inset_0_-1px_0_var(--color-line)]">
            <tr className="text-left text-xs font-semibold text-ink-600">
              <th scope="col" className="px-5 py-3">Pedido</th>
              <th scope="col" className="px-3 py-3">Paso y motivo</th>
              <th scope="col" className="px-3 py-3">Modo</th>
              <th scope="col" className="px-3 py-3">Resultado</th>
              <th scope="col" className="px-3 py-3">Guía</th>
              <th scope="col" className="px-5 py-3 text-right">Hora</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-5 py-3">
                  {order(r)}
                  {r.storeName && <span className="block text-xs text-ink-500">{r.storeName}</span>}
                </td>
                <td className="px-3 py-3 text-[13px] text-ink-700">
                  {r.variantLabel}
                  {r.transport && <span className="block text-xs text-ink-500">{r.transport}</span>}
                </td>
                <td className="px-3 py-3">
                  <ModeBadge mode={r.mode} />
                </td>
                <td className="px-3 py-3" title={r.detail ?? undefined}>
                  {outcome(r)}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-ink-700">{r.guideCode ?? "—"}</td>
                <td className="whitespace-nowrap px-5 py-3 text-right text-[13px] tabular-nums text-ink-600">{r.at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* En el teléfono, la misma fila como tarjeta de lista. */}
      <ul className="divide-y divide-line md:hidden">
        {rows.map((r) => (
          <li key={r.id} className={cn(ROW, "py-3")}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {order(r)}
              <ModeBadge mode={r.mode} />
              {outcome(r)}
            </div>
            <p className={cn(HELP, "mt-0.5")}>
              {r.variantLabel}
              {r.transport ? ` · ${r.transport}` : ""}
            </p>
            <p className="mt-0.5 text-xs tabular-nums text-ink-500">
              {r.at}
              {r.guideCode ? ` · Guía ${r.guideCode}` : ""}
              {r.storeName ? ` · ${r.storeName}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Interruptores del catálogo ──────────────────────────────────────────────

function groupBadge(entries: AutomationEntry[], org: AutomationsOrgView): ReactNode {
  const switchable = entries.filter((e) => e.control.kind !== "readonly");
  if (switchable.length === 0) return undefined;
  // Cuenta lo que de verdad corre: encendido y con su requisito encendido. Una
  // de tres posiciones cuenta en Activo (en Simulación no cambia nada afuera).
  const lit = switchable.filter((e) =>
    e.control.kind === "org_table"
      ? org.org[e.key]?.state === "on" && org.org[e.key]?.requiresOn !== false
      : e.control.kind === "org_mode"
        ? (e.key === CHATBY_ASK_KEY ? org.chatbyAsk.mode : e.key === CHATBY_HISTORY_KEY ? org.chatbyHistory.mode : org.chatbyApprox.mode) ===
          "activo"
        : (org.store?.[e.key] ?? []).some((s) => s.on && s.requiresOn),
  ).length;
  return <Badge tone={lit ? "ok" : "neutral"}>{lit ? `${lit} de ${switchable.length} encendidas` : "Todas apagadas"}</Badge>;
}

function CatalogSection({
  group,
  org,
  writable,
}: {
  group: (typeof AUTOMATION_GROUPS)[number];
  org: AutomationsOrgView;
  writable: boolean;
}) {
  const entries = AUTOMATIONS.filter((e) => e.group === group.key);
  return (
    <SettingsSection id={groupId(group.key)} title={group.title} badge={groupBadge(entries, org)} description={group.description}>
      <div className={cn(CARD, "divide-y divide-line")}>
        {entries.map((entry) =>
          entry.control.kind === "org_table" ? (
            <OrgSwitchRow key={entry.key} entry={entry} orgId={org.orgId} view={org.org[entry.key]} writable={writable} />
          ) : entry.control.kind === "store_column" ? (
            <StoreSwitchRow key={entry.key} entry={entry} views={org.store?.[entry.key] ?? null} writable={writable} />
          ) : entry.control.kind === "org_mode" && entry.key === CHATBY_HISTORY_KEY ? (
            <AskModeRow
              key={entry.key}
              entry={entry}
              orgId={org.orgId}
              view={org.chatbyHistory}
              writable={writable}
              save={setChatbyHistoryMode}
              confirmText={HISTORY_ACTIVE_CONFIRM}
            />
          ) : entry.control.kind === "org_mode" && entry.key === CHATBY_ASK_KEY ? (
            <AskModeRow key={entry.key} entry={entry} orgId={org.orgId} view={org.chatbyAsk} writable={writable} />
          ) : entry.control.kind === "org_mode" ? (
            <ApproxModeRow key={entry.key} entry={entry} orgId={org.orgId} view={org.chatbyApprox} writable={writable} />
          ) : (
            <ReadonlyRow key={entry.key} entry={entry} state={org.readonly[entry.key]} stores={org.stores} />
          ),
        )}
      </div>
      {group.key === "confirmacion" && <ApproxTestCard view={org.chatbyApprox} />}
    </SettingsSection>
  );
}

function OrgSwitchRow({
  entry,
  orgId,
  view,
  writable,
}: {
  entry: AutomationEntry;
  orgId: string;
  view: OrgSwitchView | undefined;
  writable: boolean;
}) {
  const id = useId();
  const state = view?.state ?? "unknown";
  const [checked, setChecked] = useState(state === "on");
  useEffect(() => setChecked(state === "on"), [state]);
  const [status, setStatus] = useState<Status>(null);
  const [pending, startTransition] = useTransition();
  const needsRequirement = entry.control.kind === "org_table" && !!entry.control.requires && !view?.requiresOn;

  // Apagar siempre se puede; encender, solo con su requisito y su fila.
  const blocked =
    state === "missing"
      ? "Sin configurar en tu organización."
      : state === "unknown"
        ? "No se pudo leer su estado."
        : needsRequirement
          ? checked
            ? inertText(entry)
            : (entry.requiresReason ?? null)
          : null;
  const disabled = !writable || state === "missing" || state === "unknown" || (!checked && needsRequirement);

  const toggle = (next: boolean) => {
    if (pending) return;
    if (next && needsConfirmation(entry) && !window.confirm(confirmationText(entry))) return;
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await setOrgAutomation(orgId, entry.key, next);
        if (!result.error) setChecked(next);
        setStatus(statusOf(result));
      } catch {
        setStatus({ kind: "error", text: NETWORK_ERROR });
      }
    });
  };

  return (
    <div className={ROW}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <EntryHead entry={entry} nameId={`${id}-name`} descId={`${id}-desc`} />
          <EntryLinks entry={entry} stores={[]} />
        </div>
        {state === "missing" || state === "unknown" ? (
          <Badge tone="neutral">{state === "missing" ? "Sin configurar" : "Sin dato"}</Badge>
        ) : (
          <LiveSwitch
            checked={checked}
            disabled={disabled}
            pending={pending}
            onChange={toggle}
            labelledBy={`${id}-name`}
            describedBy={`${id}-desc`}
          />
        )}
      </div>
      <div className="mt-1.5">
        <RowStatus pending={pending} status={status} blocked={blocked} />
      </div>
    </div>
  );
}

function StoreSwitchRow({ entry, views, writable }: { entry: AutomationEntry; views: StoreSwitchView[] | null; writable: boolean }) {
  const id = useId();
  return (
    <div className={ROW}>
      <EntryHead entry={entry} nameId={`${id}-name`} descId={`${id}-desc`} />
      {views === null ? (
        <p className="mt-2 text-[13px] text-warn-fg">No se pudieron leer las tiendas.</p>
      ) : views.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-500">No hay tiendas activas.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line rounded-md ring-1 ring-inset ring-line">
          {views.map((view) => (
            <StoreSwitch key={view.storeId} entry={entry} view={view} nameId={`${id}-name`} writable={writable} />
          ))}
        </ul>
      )}
    </div>
  );
}

function StoreSwitch({ entry, view, nameId, writable }: { entry: AutomationEntry; view: StoreSwitchView; nameId: string; writable: boolean }) {
  const id = useId();
  const [checked, setChecked] = useState(view.on);
  useEffect(() => setChecked(view.on), [view.on]);
  const [status, setStatus] = useState<Status>(null);
  const [pending, startTransition] = useTransition();
  const needsRequirement = !view.requiresOn;
  const blocked = needsRequirement ? (checked ? inertText(entry) : (entry.requiresReason ?? null)) : null;

  const toggle = (next: boolean) => {
    if (pending) return;
    if (next && needsConfirmation(entry) && !window.confirm(confirmationText(entry, view.storeName))) return;
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await setStoreAutomation(view.storeId, entry.key, next);
        if (!result.error) setChecked(next);
        setStatus(statusOf(result));
      } catch {
        setStatus({ kind: "error", text: NETWORK_ERROR });
      }
    });
  };

  return (
    <li className="px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span id={`${id}-store`} className="text-[13px] font-medium text-ink-900">
            {view.storeName}
          </span>
          {entry.link?.kind === "store_settings" && (
            <Link href={storeSettingsHref(view.storeId, entry.link.section)} className={cn(LINK, "ml-3 text-[13px]")}>
              Ajustes
            </Link>
          )}
        </div>
        <LiveSwitch
          checked={checked}
          disabled={!writable || (!checked && needsRequirement)}
          pending={pending}
          onChange={toggle}
          labelledBy={`${nameId} ${id}-store`}
        />
      </div>
      <RowStatus pending={pending} status={status} blocked={blocked} />
    </li>
  );
}

function ReadonlyRow({
  entry,
  state,
  stores,
}: {
  entry: AutomationEntry;
  state: { label: string; tone: "ok" | "neutral" | "warn" } | undefined;
  stores: { id: string; name: string }[];
}) {
  const id = useId();
  return (
    <div className={ROW}>
      {/* En el teléfono la chapa va debajo del texto: a su lado, con hasta
          16rem de ancho, dejaba el nombre y la descripción en unos 40 px. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 sm:flex-1">
          <EntryHead entry={entry} nameId={`${id}-name`} descId={`${id}-desc`} />
          {entry.control.kind === "readonly" && <p className="mt-1.5 max-w-[68ch] text-[13px] leading-5 text-ink-700">{entry.control.how}</p>}
          <EntryLinks entry={entry} stores={stores} />
        </div>
        {/* El estado de lo que no se cambia aquí va en chapa neutra: informa, no invita a tocar. */}
        <Badge tone={state?.tone === "warn" ? "warn" : "neutral"} wrap className="max-w-full self-start sm:max-w-[16rem] sm:shrink-0">
          {state?.label ?? "Sin dato"}
        </Badge>
      </div>
    </div>
  );
}

// ── Ubicación por WhatsApp de los reintentos de Lima (0324) ──────────────────

/**
 * Antes de Google, la ubicación que la clienta ya mandó por WhatsApp (sin
 * interruptor), y «Pedir la ubicación por WhatsApp»: Apagado / Simulación /
 * Activo, que guarda al cambiar.
 */
function WhatsappLocationSection({ orgId, view, writable }: { orgId: string; view: RetryChatbyAskView; writable: boolean }) {
  const id = useId();
  const [mode, setMode] = useState<ApproxMode>(view.mode);
  useEffect(() => setMode(view.mode), [view.mode]);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [, startTransition] = useTransition();
  const canEdit = writable && view.available;
  const blocked = !view.available
    ? "Aún no está instalada en la base de datos (0324): funciona como Apagado."
    : !view.keyPresent
      ? "Falta la clave de Chatby en Kapta (CHATBY_API_KEY): no se lee ni se pide nada."
      : null;

  const change = (next: ApproxMode): boolean => {
    if (!canEdit || pending || next === mode) return false;
    if (
      next === "activo" &&
      !window.confirm(
        "¿Poner en Activo «Pedir la ubicación por WhatsApp»? Cuando un reintento de Lima no tenga ubicación y la clienta haya escrito en las últimas 23 h, Kapta le escribirá por WhatsApp sin que una persona lo revise (una vez por reintento).",
      )
    ) {
      return false;
    }
    setPending(true);
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await setRetryChatbyAsk(orgId, next);
        if (!result.error) setMode(next);
        setStatus(statusOf(result));
      } catch {
        setStatus({ kind: "error", text: NETWORK_ERROR });
      } finally {
        setPending(false);
      }
    });
    return true;
  };

  return (
    <SettingsSection
      id="retry-whatsapp"
      title="Ubicación por WhatsApp"
      badge={!view.available ? <Badge tone="warn">No instalado</Badge> : <Badge>{APPROX_MODE_LABEL[mode]}</Badge>}
      description={
        <>
          <p>
            Antes de buscar en Google, la pasada y «Aprobar» usan la ubicación que la clienta ya mandó por WhatsApp para esta compra. No hay que
            encender nada.
          </p>
          <p>
            Si no mandó ninguna y Google tampoco da el edificio, esta fila decide si Kapta se la pide. WhatsApp solo deja mandarle texto si ella
            escribió en las últimas 24 h; si no, queda para una persona.
          </p>
        </>
      }
    >
      <div className={CARD}>
        <div className={ROW}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="min-w-0 sm:flex-1">
              <p id={`${id}-name`} className="text-sm font-semibold leading-5 text-ink-900">
                Pedir la ubicación por WhatsApp
              </p>
              <p id={`${id}-desc`} className={cn(HELP, "mt-0.5 max-w-[68ch]")}>
                Una vez por reintento, solo si la clienta escribió en las últimas 23 h, nadie del equipo le escribió y el caso no está tomado en Repro
                Lima. En Simulación, «Hoy y ayer» dice «Habría pedido su ubicación por WhatsApp» y no sale nada. Corre para los reintentos en
                Simulación o Activo de arriba: cuando la manda, la pasada siguiente cotiza con ella (con el reintento en Simulación, lo aprueba una
                persona).
              </p>
            </div>
            <ModeControl value={mode} label="Pedir la ubicación por WhatsApp" disabled={!canEdit} pending={pending} onChange={change} />
          </div>
          <div className="mt-1.5">
            <RowStatus pending={pending} status={status} blocked={blocked} />
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}

// ── Pedir sola la dirección o la ubicación (Chatby, 0318) ────────────────────

/** Apagado / Simulación / Activo de los mensajes que piden la dirección o la ubicación; guarda al cambiar. */
const ASK_ACTIVE_CONFIRM =
  "¿Poner en Activo «Pedir sola la dirección o la ubicación»? Cuando la clienta confirme por Chatby y la guía no salga por la dirección, Kapta le escribirá por WhatsApp sin que una asesora lo revise (una vez para la dirección y una para la ubicación).";
const HISTORY_ACTIVE_CONFIRM =
  "¿Poner en Activo «Guía automática para clientas con entregas»? Cuando la clienta confirme por Chatby y la guía no salga por la dirección, si ya recibió en esa misma dirección sin ningún fallido, Kapta creará la guía Aliclik con el GPS de esa entrega y confirmará el pedido sin que una asesora lo revise.";

/**
 * Apagado / Simulación / Activo de una columna de `chatby_auto_settings`:
 * «Pedir sola la dirección o la ubicación» (0318) y, con su acción y su
 * aviso, «Guía automática para clientas con entregas» (0317).
 */
function AskModeRow({
  entry,
  orgId,
  view,
  writable,
  save = setChatbyAskMode,
  confirmText = ASK_ACTIVE_CONFIRM,
}: {
  entry: AutomationEntry;
  orgId: string;
  view: ChatbyAskModeView;
  writable: boolean;
  save?: (orgId: string, mode: string) => Promise<AutomationActionResult>;
  confirmText?: string;
}) {
  const id = useId();
  const [mode, setMode] = useState<ApproxMode>(view.mode);
  useEffect(() => setMode(view.mode), [view.mode]);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [, startTransition] = useTransition();
  const canEdit = writable && view.available && view.rowExists;
  const blocked = !view.available
    ? "Aún no está instalada en la base de datos: funciona como Apagado."
    : !view.rowExists
      ? "Sin configurar en tu organización."
      : null;

  const change = (next: ApproxMode): boolean => {
    if (!canEdit || pending || next === mode) return false;
    if (next === "activo" && !window.confirm(confirmText)) return false;
    setPending(true);
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await save(orgId, next);
        if (!result.error) setMode(next);
        setStatus(statusOf(result));
      } catch {
        setStatus({ kind: "error", text: NETWORK_ERROR });
      } finally {
        setPending(false);
      }
    });
    return true;
  };

  return (
    <div className={ROW}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 sm:flex-1">
          <EntryHead entry={entry} nameId={`${id}-name`} descId={`${id}-desc`} />
        </div>
        <ModeControl value={mode} label={entry.name} disabled={!canEdit} pending={pending} onChange={change} />
      </div>
      <div className="mt-1.5">
        <RowStatus pending={pending} status={status} blocked={blocked} />
      </div>
    </div>
  );
}

// ── Ubicación aproximada en la calle correcta (Chatby, 0316) ─────────────────

/** La fila del catálogo con Apagado / Simulación / Activo, que guarda al cambiar. */
function ApproxModeRow({ entry, orgId, view, writable }: { entry: AutomationEntry; orgId: string; view: ChatbyApproxView; writable: boolean }) {
  const id = useId();
  const [mode, setMode] = useState<ApproxMode>(view.mode);
  useEffect(() => setMode(view.mode), [view.mode]);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [, startTransition] = useTransition();
  const canEdit = writable && view.available && view.rowExists;
  const blocked = !view.available
    ? "Aún no está instalada en la base de datos: funciona como Apagado."
    : !view.rowExists
      ? "Sin configurar en tu organización."
      : null;

  const change = (next: ApproxMode): boolean => {
    if (!canEdit || pending || next === mode) return false;
    if (
      next === "activo" &&
      !window.confirm(
        "¿Poner en Activo la ubicación aproximada? Cuando Google dé el número de la cuadra de la misma calle, número y provincia, Kapta creará la guía de Aliclik con ese punto y confirmará el pedido, sin que una asesora lo revise.",
      )
    ) {
      return false;
    }
    setPending(true);
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await setChatbyApproxMode(orgId, next);
        if (!result.error) setMode(next);
        setStatus(statusOf(result));
      } catch {
        setStatus({ kind: "error", text: NETWORK_ERROR });
      } finally {
        setPending(false);
      }
    });
    return true;
  };

  return (
    <div className={ROW}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 sm:flex-1">
          <EntryHead entry={entry} nameId={`${id}-name`} descId={`${id}-desc`} />
          <p className="mt-1.5 text-[13px]">
            <a href={`#${APPROX_TEST_ID}`} className={LINK}>
              Ver la prueba
            </a>
          </p>
        </div>
        <ModeControl value={mode} label={entry.name} disabled={!canEdit} pending={pending} onChange={change} />
      </div>
      <div className="mt-1.5">
        <RowStatus pending={pending} status={status} blocked={blocked} />
      </div>
    </div>
  );
}

const fmtMeters = (m: number) => `${Math.round(m).toLocaleString("es-PE")} m`;

/** Dónde estuvo el motorizado, en palabras o como enlace al mapa. */
function ReferenceCell({ reference }: { reference: ApproxReference }) {
  if (reference.state === "sin_entregar") return <span className="text-ink-500">Aún no entregado</span>;
  if (reference.state === "sin_punto") return <span className="text-ink-500">Entregado, sin punto en la guía</span>;
  return (
    <span className="block">
      <a href={mapsHref(reference.point)} target="_blank" rel="noreferrer" className={LINK}>
        Ver en el mapa
      </a>
      {reference.state === "mismo_punto" && <span className="block text-xs text-ink-500">Es el punto que mandó Kapta: no mide</span>}
    </span>
  );
}

function DistanceCell({ reference }: { reference: ApproxReference }) {
  if (reference.state !== "medido") return <span className="text-ink-500">—</span>;
  const near = reference.distanceM < APPROX_NEAR_METERS;
  return <span className={cn("font-medium tabular-nums", near ? "text-ok-fg" : "text-warn-fg")}>{fmtMeters(reference.distanceM)}</span>;
}

function ApproxModeBadge({ mode }: { mode: ApproxReportRow["mode"] }) {
  return mode === "activo" ? <Badge tone="brand">Activo</Badge> : <Badge tone="info">Simulación</Badge>;
}

/**
 * «Prueba de ubicación aproximada»: cada pedido con punto aproximado, dónde
 * estuvo después el motorizado y la distancia. Se calcula al abrir el panel.
 */
function ApproxTestCard({ view }: { view: ChatbyApproxView }) {
  const rows = view.rows;
  const summary = view.summary;
  const order = (r: ApproxReportRow) => (
    <Link href={`/dashboard/pedidos?abrir=${r.orderId}`} className={cn(LINK, "font-semibold")}>
      {r.orderName}
    </Link>
  );
  const approxLink = (r: ApproxReportRow) => (
    <a href={mapsHref(r.approx)} target="_blank" rel="noreferrer" className={LINK}>
      Ver en el mapa
    </a>
  );
  return (
    <div id={APPROX_TEST_ID} className={cn(CARD, "scroll-mt-20 xl:scroll-mt-6")}>
      <CardHeader
        title="Prueba de ubicación aproximada"
        description={
          <>
            <p>
              Los pedidos donde Google dio el número de la cuadra de la calle correcta, y a qué distancia quedó ese punto del que trae la guía de
              Aliclik cuando ya se entregó o se intentó. La distancia típica es la mediana.
            </p>
            {view.available && view.mode === "apagado" && rows.length === 0 && (
              <p className="mt-1">Pon la posición en Simulación para juntar pedidos sin cambiar nada de lo que hace Chatby.</p>
            )}
          </>
        }
        aside={<Badge tone="neutral">{`Posición: ${APPROX_MODE_LABEL[view.mode]}`}</Badge>}
      />
      <div className={cn(ROW, "border-t border-line py-3")}>
        <p className="text-sm font-medium text-ink-900">{approxSummaryLine(summary)}</p>
        {summary.total > 0 && (
          <p className={cn(HELP, "mt-0.5")}>
            {summary.total.toLocaleString("es-PE")} {summary.total === 1 ? "pedido en la prueba" : "pedidos en la prueba"} ·{" "}
            {summary.pending.toLocaleString("es-PE")} aún sin entregar
            {summary.nearPct != null
              ? ` · ${summary.nearPct.toLocaleString("es-PE", { maximumFractionDigits: 0 })} % a menos de ${APPROX_NEAR_METERS} m`
              : ""}
          </p>
        )}
      </div>
      {!view.available ? (
        <p className={cn(ROW, "border-t border-line text-sm text-ink-500")}>La prueba aún no está instalada en la base de datos.</p>
      ) : rows.length === 0 ? (
        <p className={cn(ROW, "border-t border-line text-sm text-ink-500")}>Todavía no hay pedidos con ubicación aproximada.</p>
      ) : (
        <>
          {/* Desde `md`, tabla con cabecera pegajosa y su propio desplazamiento. */}
          <div className="hidden max-h-[60vh] overflow-y-auto border-t border-line md:block">
            <table className="w-full text-sm">
              <caption className="sr-only">Pedidos de la prueba de ubicación aproximada</caption>
              <thead className="sticky top-0 z-10 bg-white shadow-[inset_0_-1px_0_var(--color-line)]">
                <tr className="text-left text-xs font-semibold text-ink-600">
                  <th scope="col" className="px-5 py-3">Pedido</th>
                  <th scope="col" className="px-3 py-3">Dirección</th>
                  <th scope="col" className="px-3 py-3">Punto aproximado</th>
                  <th scope="col" className="px-3 py-3">Dónde estuvo el motorizado</th>
                  <th scope="col" className="px-5 py-3 text-right">Distancia</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.orderId} className="align-top">
                    <td className="px-5 py-3">
                      {order(r)}
                      <span className="mt-1 block">
                        <ApproxModeBadge mode={r.mode} />
                      </span>
                    </td>
                    <td className="max-w-[28ch] px-3 py-3 text-[13px] text-ink-700">{r.address ?? "—"}</td>
                    <td className="px-3 py-3 text-[13px]">{approxLink(r)}</td>
                    <td className="px-3 py-3 text-[13px]">
                      <ReferenceCell reference={r.reference} />
                    </td>
                    <td className="whitespace-nowrap px-5 py-3 text-right text-[13px]">
                      <DistanceCell reference={r.reference} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* En el teléfono, cada pedido como tarjeta de lista. */}
          <ul className="divide-y divide-line border-t border-line md:hidden">
            {rows.map((r) => (
              <li key={r.orderId} className={cn(ROW, "py-3")}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    {order(r)}
                    <ApproxModeBadge mode={r.mode} />
                  </span>
                  <DistanceCell reference={r.reference} />
                </div>
                {r.address && <p className={cn(HELP, "mt-0.5 break-words")}>{r.address}</p>}
                <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
                  <dt className="text-ink-500">Punto aproximado</dt>
                  <dd>{approxLink(r)}</dd>
                  <dt className="text-ink-500">Motorizado</dt>
                  <dd>
                    <ReferenceCell reference={r.reference} />
                  </dd>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ── Últimos cambios ─────────────────────────────────────────────────────────

function EventsSection({ org }: { org: AutomationsOrgView }) {
  return (
    <SettingsSection id="ultimos-cambios" title="Últimos cambios" description="Quién movió cada interruptor de este panel y cuándo. Los 20 más recientes.">
      <div className={CARD}>
        {org.events.length === 0 ? (
          <p className={cn(ROW, "text-sm text-ink-500")}>Todavía nadie cambió nada desde este panel.</p>
        ) : (
          <ul className="divide-y divide-line">
            {org.events.map((e) => (
              <li key={e.id} className={cn(ROW, "py-3")}>
                <p className="text-sm text-ink-900">
                  <span className="font-semibold">{e.what}</span>
                  {e.storeName && <span className="text-ink-600"> · {e.storeName}</span>}
                </p>
                <p className={cn(HELP, "mt-0.5")}>
                  {e.previous} → <span className="font-medium text-ink-700">{e.next}</span> · {e.actor} · <span className="tabular-nums">{e.at}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
