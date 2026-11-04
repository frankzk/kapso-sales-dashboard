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
import { CARD, HELP, NUMBER_NARROW, ROW, SettingsGroup, SettingsIndex, SettingsSection, type IndexGroup } from "@/components/settings-ui";
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
  type AutomationEffect,
  type AutomationEntry,
  type AutomationGroup,
} from "@/lib/automations-catalog";
import type { AutomationsOrgView, OrgSwitchView, RetryLogView, StoreSwitchView } from "@/lib/automations-access";
import {
  setOrgAutomation,
  setRetryDailyCap,
  setRetryVariantMode,
  setStoreAutomation,
  simulateRetriesNow,
  type AutomationActionResult,
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
};

const groupId = (key: AutomationGroup) => `grupo-${key}`;

const INDEX: IndexGroup[] = [
  {
    title: "Reintentos Aliclik en Lima",
    items: [
      { id: "retry-variantes", label: "Posición de cada reintento" },
      { id: "retry-tope", label: "Tope del día" },
      { id: "retry-simular", label: "Simular ahora" },
      { id: "retry-registro", label: "Hoy y ayer" },
    ],
  },
  { title: "Interruptores", items: AUTOMATION_GROUPS.map((g) => ({ id: groupId(g.key), label: g.title })) },
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
      description="Revisa ahora los pedidos listos para reintentar y dice qué guía saldría, sin crear ninguna. Mira todos los pasos, también los apagados. Consulta a Aliclik, así que puede tardar."
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
  // Cuenta lo que de verdad corre: encendido y con su requisito encendido.
  const lit = switchable.filter((e) =>
    e.control.kind === "org_table"
      ? org.org[e.key]?.state === "on" && org.org[e.key]?.requiresOn !== false
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
          ) : (
            <ReadonlyRow key={entry.key} entry={entry} state={org.readonly[entry.key]} stores={org.stores} />
          ),
        )}
      </div>
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
