"use client";

// Ajustes → «Boletas y facturas» (MOM §35): los RUC de la organización con su
// cuenta de SimpleFact, a qué RUC va el dinero de cada cuenta de cobro de esta
// tienda y los últimos comprobantes. Con un RUC en «Manual», la simulada más
// nueva de un pedido lleva «Emitir» exactamente cuando el drawer de ese pedido
// ofrecería «Emitir esta boleta»: lo decide la misma función en el servidor, y
// es la misma acción con la misma confirmación.
//
// Va en su propio archivo, fuera de store-settings.tsx, porque no guarda en la
// fila de la tienda: los RUC son de la organización y las acciones piden un
// permiso que no es el de Ajustes («Boletas y facturas», solo lo da el owner).
//
// El token no llega nunca aquí: la página manda solo si hay uno (`hasToken`).
// Este archivo no importa nada que arrastre `node:crypto` (lib/crypto.ts,
// lib/invoicing/server.ts): las reglas puras, las acciones de servidor y las
// piezas del panel del drawer (que tampoco lo arrastran), nada más.

import { useActionState, useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton, type BadgeTone } from "@/components/ops-ui";
import { CARD, CardHeader, EmptyRow, Field, HELP, NUMBER_NARROW, ROW, RowList, SettingsSection } from "@/components/settings-ui";
import { IconAlert, IconCheckCircle } from "@/components/icons";
import { OrderLink } from "@/components/order-link";
import { EmitInvoiceControl, EmitOutcome } from "@/components/order-invoice-panel";
import {
  INVOICE_DAILY_LIMIT_DEFAULT,
  INVOICE_DAILY_LIMIT_MAX,
  INVOICE_DAILY_LIMIT_MIN,
  INVOICE_MODE_LABEL,
  INVOICE_REASON_LABEL,
  INVOICE_STATUS_LABEL,
  type InvoiceMode,
  type InvoiceStatus,
  type InvoiceWriteMode,
} from "@/lib/invoicing/rules";
import { statementAccountKey } from "@/lib/yape-statement/match";
import {
  saveInvoiceIssuer,
  setAccountInvoiceIssuer,
  testInvoiceIssuer,
} from "@/app/dashboard/[storeId]/settings/invoice-actions";
import type { SettingsState } from "@/app/dashboard/[storeId]/settings/actions";
// La acción del drawer: la emisión y sus candados son los mismos desde aquí.
import {
  emitInvoiceAction,
  type EmitInvoiceState,
  type InvoicePanelEmitNow,
} from "@/app/dashboard/pedidos/invoice-actions";

const initial: SettingsState = {};

// ── Lo que manda la página ───────────────────────────────────────────────────

/** Un RUC de la organización, sin el token. */
export interface InvoiceIssuerView {
  id: string;
  ruc: string;
  legalName: string;
  subdomain: string;
  mode: InvoiceMode;
  /** «Emitir desde» como valor de `datetime-local` en hora de Lima; "" sin fecha. */
  emitFromInput: string;
  dailyLimit: number;
  /** Solo sí/no: el token nunca sale del servidor. */
  hasToken: boolean;
  checkedAt: string | null;
  checkedRuc: string | null;
  checkError: string | null;
  /** Lo de hoy (día de Lima); null si no se pudo leer. */
  today: { emitidas: number; simuladas: number; enDuda: number; errores: number } | null;
}

/** Una cuenta de cobro ACTIVA de esta tienda (`store_collection_accounts`). */
export interface InvoiceAccountView {
  id: string;
  label: string;
  aliases: string[];
  /** null = sin celular: la pasarela Flow (0198). */
  phoneLastDigits: string | null;
  issuerId: string | null;
}

export interface InvoiceRecentView {
  id: string;
  orderId: string;
  orderName: string | null;
  /** El RUC del comprobante (`issuer_id`): con él se emite la real de una simulada. */
  issuerId: string | null;
  ruc: string;
  mode: InvoiceWriteMode;
  status: InvoiceStatus;
  serie: string | null;
  correlative: string | null;
  total: number;
  error: string | null;
  createdAt: string;
  /**
   * SimpleFact contestó con archivos de OTRO RUC (`ruc_mismatch`): la boleta
   * existe, pero no es de la empresa que recibió el pago. El motivo va en `error`.
   */
  rucMismatch: boolean;
  /**
   * Lleva «Emitir», y lo que saldría: la simulada más nueva de su pedido, y el
   * drawer ofrecería ahora «Emitir esta boleta» para ese pedido
   * (`invoiceEmitNowReadiness`: tienda activa, sin comprobante real vivo, las
   * reglas como una emisión real, el RUC ACTUAL del pedido en «Manual» y sin un
   * bloqueo de Shopify). El RUC y el total son los de las reglas de ahora, que
   * pueden no ser los de la simulada: la confirmación dice lo que de verdad se
   * envía. null: no lleva botón. Al pulsar, el servidor vuelve a revisar todo.
   * Un pedido pagado antes de «Emitir desde» (`beforeStart`) lo lleva igual, y
   * su confirmación pide la casilla «Revisé en SimpleFact…», como el drawer.
   */
  emitNow: InvoicePanelEmitNow | null;
}

/** null en una lista = no se pudo leer (pre-0257 o una caída): no es «no hay». */
export interface InvoiceSettingsData {
  /** Quien mira tiene «Boletas y facturas». Sin él no se manda nada más. */
  canManage: boolean;
  /**
   * Este despliegue emite: es producción (`invoiceEmitAllowedHere`). En una
   * vista previa no hay «Emitir» —comparte la base y la llave de cifrado con
   * producción, y desde ella saldría una boleta real— y, con un RUC en
   * «Manual», se dice por qué. false si no se supo (falla cerrada).
   */
  emitHere: boolean;
  issuers: InvoiceIssuerView[] | null;
  accounts: InvoiceAccountView[] | null;
  recent: InvoiceRecentView[] | null;
}

/** Lo que se le enseña al cliente para pagar (`store_payment_methods`, 0166). */
export interface InvoicePaymentMethod {
  kind: string;
  label: string;
  holder: string;
  account: string;
  active: boolean;
}

// ── Piezas ───────────────────────────────────────────────────────────────────

const DATE_TIME = new Intl.DateTimeFormat("es-PE", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Lima",
});

function when(iso: string | null): string {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? DATE_TIME.format(new Date(t)) : "—";
}

const MODE_TONE: Record<InvoiceMode, BadgeTone> = { apagado: "neutral", simulacion: "info", manual: "brand", real: "ok" };

const STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
  simulada: "info",
  emitiendo: "info",
  emitida: "ok",
  en_duda: "warn",
  error: "crit",
  externa: "neutral",
};

/**
 * Qué hace cada modo, en una línea (MOM §35.8). «Manual» es el paso entre la
 * simulación y lo automático (owner, 15-10-2026): las primeras boletas reales
 * salen una a una y se revisan en SimpleFact antes de pasar a Real.
 */
export const MODE_HELP: Record<InvoiceMode, string> = {
  apagado: "No revisa ni emite nada.",
  simulacion: "Revisa cada pedido y guarda la boleta que habría enviado, sin mandarla a SimpleFact.",
  manual:
    "Revisa y simula como Simulación; tú emites cada boleta con «Emitir esta boleta» en el pedido. Pide lo mismo que Real.",
  real: "Automático: el barrido emite cada boleta en SimpleFact, que la manda a SUNAT. Pide token, «Emitir desde» y una prueba de conexión que leyó este RUC.",
};

/** Los modos en el orden en que se enciende un RUC. */
const MODE_ORDER: readonly InvoiceMode[] = ["apagado", "simulacion", "manual", "real"];

function ModeBadge({ mode }: { mode: InvoiceMode }) {
  return <Badge tone={MODE_TONE[mode] ?? "neutral"}>{INVOICE_MODE_LABEL[mode] ?? mode}</Badge>;
}

/** Enlace a otra sección de Ajustes. */
function SectionLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a href={`#${to}`} className="font-medium text-brand-700 hover:underline">
      {children}
    </a>
  );
}

/** El token: cifrado, nunca se vuelve a mostrar. Vacío al guardar = se conserva. */
function TokenField({ id, set }: { id: string; set: boolean }) {
  return (
    <Field
      label="Token de la API de SimpleFact"
      htmlFor={id}
      mark={<Badge tone={set ? "ok" : "neutral"}>{set ? "Configurado" : "Sin configurar"}</Badge>}
      hint={
        <p>
          Se guarda <strong>cifrado</strong> y no se vuelve a mostrar. Pégalo aquí, nunca en un chat. Cambiarlo pide
          volver a probar la conexión: un RUC en Manual o en Real baja a Simulación.
        </p>
      }
    >
      <input
        id={id}
        name="token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder={set ? "Déjalo en blanco para conservarlo" : "Pega el token"}
        className={FIELD}
      />
    </Field>
  );
}

/** Estado de un formulario: lo que falta guardar, o lo que respondió el servidor. */
function FormStatus({ dirty, pending, state }: { dirty: boolean; pending: boolean; state: SettingsState }) {
  if (pending) return null;
  if (dirty) return <span className="font-medium text-ink-600">Cambios sin guardar</span>;
  if (state.error) {
    return (
      <span className="inline-flex items-start gap-1.5 text-crit-fg">
        <IconAlert className="mt-0.5 size-3.5 shrink-0" />
        <span className="whitespace-pre-line">{state.error}</span>
      </span>
    );
  }
  if (state.notice) {
    return (
      <span className="inline-flex items-start gap-1.5 text-ok-fg">
        <IconCheckCircle className="mt-0.5 size-3.5 shrink-0" />
        <span className="whitespace-pre-line">{state.notice}</span>
      </span>
    );
  }
  return null;
}

/**
 * Un formulario que se envía a mano (como `StoreForm` de Ajustes) y no con
 * `action={…}`: React 19 vacía el formulario al terminar cualquier acción,
 * también la que vuelve con error, y lo escrito se perdía. Así, con error lo
 * escrito se queda; con éxito se refresca la página y, ya con lo guardado,
 * `round` sube: es parte de la `key` del formulario, que se vuelve a montar con
 * lo persistido. Eso es lo que vacía el token: si se quedara escrito, el
 * próximo «Guardar» lo mandaría otra vez y desharía la prueba de conexión.
 */
function useIssuerForm(storeId: string) {
  const [state, action, pending] = useActionState(
    (prev: SettingsState, fd: FormData) => saveInvoiceIssuer(storeId, prev, fd),
    initial,
  );
  const [, startSave] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const [dirty, setDirty] = useState(false);
  const [round, setRound] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (state === initial || state.error) return;
    setWaiting(true);
    startRefresh(() => router.refresh());
  }, [router, state]);

  useEffect(() => {
    if (refreshing || !waiting) return;
    setWaiting(false);
    setRound((r) => r + 1);
  }, [refreshing, waiting]);

  return {
    state,
    round,
    busy: pending || refreshing,
    dirty,
    onChange: () => setDirty(true),
    onSubmit: (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      setDirty(false);
      startSave(() => action(fd));
    },
  };
}

function FormFooter({
  dirty,
  busy,
  state,
  label,
}: {
  dirty: boolean;
  busy: boolean;
  state: SettingsState;
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
      <p role="status" className="mr-auto min-w-0 text-[13px] leading-5">
        <FormStatus dirty={dirty} pending={busy} state={state} />
      </p>
      <OpsButton type="submit" variant="primary" disabled={busy} className="pointer-coarse:h-11">
        {busy ? "Guardando…" : label}
      </OpsButton>
    </div>
  );
}

/**
 * Los campos de un RUC. `issuer` null = alta: nace Apagado, y Manual y Real no
 * se ofrecen porque piden una prueba de conexión que un RUC nuevo todavía no
 * tiene.
 */
function IssuerFields({ idPrefix, issuer }: { idPrefix: string; issuer: InvoiceIssuerView | null }) {
  const id = (name: string) => `${idPrefix}-${name}`;
  const modes: readonly InvoiceMode[] = issuer ? MODE_ORDER : ["apagado", "simulacion"];
  return (
    <div className={cn(ROW, "grid gap-x-4 gap-y-5 sm:grid-cols-2")}>
      <Field label="RUC" htmlFor={id("ruc")}>
        <input
          id={id("ruc")}
          name="ruc"
          inputMode="numeric"
          autoComplete="off"
          maxLength={11}
          required
          defaultValue={issuer?.ruc ?? ""}
          placeholder="20556792829"
          className={cn(FIELD, "tabular-nums")}
        />
      </Field>
      <Field label="Razón social" htmlFor={id("legal_name")}>
        <input
          id={id("legal_name")}
          name="legal_name"
          maxLength={200}
          required
          defaultValue={issuer?.legalName ?? ""}
          placeholder="GRUPO GF S.A.C."
          className={FIELD}
        />
      </Field>
      <Field
        label="Subdominio de SimpleFact"
        htmlFor={id("subdomain")}
        hint={<p>Lo que va antes de <code>.simplefact.pe</code>. Se puede pegar la dirección entera.</p>}
      >
        <div className="flex items-center gap-2">
          <input
            id={id("subdomain")}
            name="subdomain"
            autoComplete="off"
            spellCheck={false}
            required
            defaultValue={issuer?.subdomain ?? ""}
            placeholder="grupogf"
            className={FIELD}
          />
          <span className="shrink-0 text-sm text-ink-500">.simplefact.pe</span>
        </div>
      </Field>
      <TokenField id={id("token")} set={issuer?.hasToken ?? false} />
      <Field
        label="Modo"
        htmlFor={id("mode")}
        hint={
          <ul className="space-y-1">
            {MODE_ORDER.map((m) => (
              <li key={m}>
                <strong>{INVOICE_MODE_LABEL[m]}:</strong> {MODE_HELP[m]}
              </li>
            ))}
            {!issuer && <li>Un RUC nuevo pasa a Manual o a Real después de probar su conexión.</li>}
          </ul>
        }
      >
        <select id={id("mode")} name="mode" defaultValue={issuer?.mode ?? "apagado"} className={FIELD}>
          {modes.map((m) => (
            <option key={m} value={m}>
              {INVOICE_MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid content-start gap-y-5">
        <Field
          label="Emitir desde"
          htmlFor={id("emit_from")}
          hint={
            <p>
              Hora de Lima. Solo entran pedidos que quedaron pagados desde aquí: una fecha en el pasado se guarda
              como ahora, y al cambiar de modo, si quedó atrás, se mueve sola a ese momento.
            </p>
          }
        >
          <input
            id={id("emit_from")}
            name="emit_from"
            type="datetime-local"
            defaultValue={issuer?.emitFromInput ?? ""}
            className={cn(FIELD, "tabular-nums")}
          />
        </Field>
        <Field
          label="Tope diario"
          htmlFor={id("daily_limit")}
          hint={
            <p>
              Boletas por día de Lima, de {INVOICE_DAILY_LIMIT_MIN} a {INVOICE_DAILY_LIMIT_MAX}. Cuenta lo emitido, lo
              que se está emitiendo y lo que está en duda; lo que pasa del tope sale al día siguiente. En Manual, lo
              simulado y lo emitido con el botón cuentan cada uno por su lado.
            </p>
          }
        >
          <input
            id={id("daily_limit")}
            name="daily_limit"
            type="number"
            inputMode="numeric"
            min={INVOICE_DAILY_LIMIT_MIN}
            max={INVOICE_DAILY_LIMIT_MAX}
            step={1}
            required
            defaultValue={issuer?.dailyLimit ?? INVOICE_DAILY_LIMIT_DEFAULT}
            className={cn(NUMBER_NARROW, "w-28")}
          />
        </Field>
      </div>
    </div>
  );
}

/**
 * La última prueba de conexión: qué RUC leyó y cuándo, o qué falló.
 *
 * EL MOTIVO SE ENSEÑA SIEMPRE QUE ESTÉ. Cuando el barrido apaga un RUC por su
 * cuenta (otro RUC en la respuesta, un token rechazado) borra la prueba
 * —`checked_at` y `checked_ruc`— y deja el motivo en `check_error` (§35.4).
 * Antes, sin fecha, esto decía «Sin probar» y el owner no sabía por qué se
 * había apagado ni qué arreglar antes de volver a Real.
 */
function CheckLine({ issuer: i }: { issuer: InvoiceIssuerView }) {
  if (!i.checkedAt) {
    // Como lo guardó quien lo escribió, sin el punto final: la frase sigue.
    const why = (i.checkError ?? "").trim().replace(/[.\s]+$/, "");
    // «o a Manual»: Manual también manda boletas a SUNAT y la base le exige la
    // misma prueba que a Real (0261). Decir solo Real dejaba creer que a Manual
    // se podía volver sin probar.
    if (why && i.mode === "apagado") {
      return (
        <span className="text-crit-fg">
          Apagado por Kapta: {why}. Prueba la conexión antes de volver a Real o a Manual.
        </span>
      );
    }
    if (why) {
      // Sin fecha, con motivo y encendido: lo apagó el barrido y se volvió a
      // encender sin probar, o se cambió el token después de una prueba
      // fallida. En los dos casos lo cierto es que no está probado.
      return (
        <span className="text-warn-fg">
          Sin probar. Lo último que falló: {why}. Prueba la conexión antes de pasar a Real.
        </span>
      );
    }
    return (
      <span className="text-ink-500">
        Sin probar. «Probar conexión» lee las ventas de la cuenta y confirma de qué RUC son: sin eso no pasa a Manual
        ni a Real.
      </span>
    );
  }
  const at = when(i.checkedAt);
  if (i.checkError) {
    return (
      <span className="text-crit-fg">
        Última prueba ({at}): {i.checkError}
      </span>
    );
  }
  if (i.checkedRuc === i.ruc) {
    return (
      <span className="text-ok-fg">
        Última prueba ({at}): leyó el RUC <span className="tabular-nums">{i.checkedRuc}</span> ✓
      </span>
    );
  }
  return (
    <span className="text-warn-fg">
      Última prueba ({at}): leyó el RUC <span className="tabular-nums">{i.checkedRuc ?? "—"}</span>, no el{" "}
      <span className="tabular-nums">{i.ruc}</span>.
    </span>
  );
}

/**
 * Lo de hoy del RUC. «Emitidas» cuenta las reales de hoy en cualquier modo: en
 * Manual son las que salieron con «Emitir esta boleta», y son las que hay que
 * revisar en SimpleFact antes de pasar a Real.
 */
function TodayCounts({ issuer: i }: { issuer: InvoiceIssuerView }) {
  if (!i.today) return <p className={HELP}>No se pudo leer lo de hoy.</p>;
  const items: Array<[string, number, string]> = [
    ["Emitidas", i.today.emitidas, "text-ink-900"],
    ["Simuladas", i.today.simuladas, "text-ink-900"],
    ["En duda", i.today.enDuda, i.today.enDuda ? "text-warn-fg" : "text-ink-900"],
    ["Con error", i.today.errores, i.today.errores ? "text-crit-fg" : "text-ink-900"],
  ];
  return (
    <div>
      <p className="text-[13px] font-medium leading-5 text-ink-700">Hoy</p>
      <dl className="mt-1 flex flex-wrap gap-x-6 gap-y-2">
        {items.map(([label, value, tone]) => (
          <div key={label} className="min-w-16">
            <dt className="text-xs leading-4 text-ink-500">{label}</dt>
            <dd className={cn("text-base font-semibold leading-6 tabular-nums", tone)}>{value}</dd>
          </div>
        ))}
        <div className="min-w-16">
          <dt className="text-xs leading-4 text-ink-500">Tope</dt>
          <dd className="text-base font-semibold leading-6 tabular-nums text-ink-900">{i.dailyLimit}</dd>
        </div>
      </dl>
    </div>
  );
}

function IssuerCard({ storeId, issuer: i }: { storeId: string; issuer: InvoiceIssuerView }) {
  const form = useIssuerForm(storeId);
  const [testing, startTest] = useTransition();
  const [test, setTest] = useState<SettingsState>(initial);
  const router = useRouter();

  function probar() {
    startTest(async () => {
      const res = await testInvoiceIssuer(storeId, i.id);
      setTest(res);
      router.refresh();
    });
  }

  // Lo PERSISTIDO de los campos: uno no controlado conserva el `defaultValue`
  // con el que se montó, así que el formulario se vuelve a montar cuando cambia
  // lo guardado (también si una prueba fallida bajó el RUC de Real), o tras
  // guardar. La prueba sola no lo toca: no borra lo que se está escribiendo.
  const persisted = JSON.stringify([i.ruc, i.legalName, i.subdomain, i.mode, i.emitFromInput, i.dailyLimit, i.hasToken]);

  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title={i.legalName}
        description={
          <p>
            RUC <span className="tabular-nums">{i.ruc}</span> · <code>{i.subdomain}.simplefact.pe</code>
          </p>
        }
        aside={
          <div className="flex flex-wrap items-center gap-2">
            <ModeBadge mode={i.mode} />
            <OpsButton
              size="sm"
              onClick={probar}
              disabled={testing || !i.hasToken}
              title={i.hasToken ? "Lee las ventas de la cuenta; no crea ninguna" : "Primero guarda el token"}
              className="pointer-coarse:h-11"
            >
              {testing ? "Probando…" : "Probar conexión"}
            </OpsButton>
          </div>
        }
      />
      <div className={cn(ROW, "space-y-3")}>
        <p className="text-[13px] leading-5">
          <CheckLine issuer={i} />
        </p>
        {(test.error || test.notice) && (
          <Banner tone={test.error ? "crit" : "ok"} role={test.error ? "alert" : "status"}>
            <p className="whitespace-pre-line break-words">{test.error ?? test.notice}</p>
          </Banner>
        )}
        <TodayCounts issuer={i} />
      </div>
      <form
        key={`${persisted}:${form.round}`}
        method="post"
        onSubmit={form.onSubmit}
        onChange={form.onChange}
        className="divide-y divide-line"
      >
        <input type="hidden" name="issuer_id" value={i.id} />
        <IssuerFields idPrefix={`ruc-${i.id}`} issuer={i} />
        <FormFooter dirty={form.dirty} busy={form.busy} state={form.state} label="Guardar" />
      </form>
    </div>
  );
}

function NewIssuerCard({ storeId }: { storeId: string }) {
  // Con el alta hecha, el formulario vuelve a vacío; con error, lo escrito se queda.
  const form = useIssuerForm(storeId);
  return (
    <details className={cn(CARD, "group")}>
      <summary className={cn(ROW, "flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden")}>
        <span>
          <span className="block text-sm font-semibold leading-5 text-ink-900">Agregar RUC</span>
          <span className={cn(HELP, "mt-0.5 block")}>
            Otra razón social con su propia cuenta de SimpleFact. Nace en Apagado.
          </span>
        </span>
        <span aria-hidden className="text-sm font-medium text-brand-700 group-open:hidden">
          Agregar
        </span>
      </summary>
      <form
        key={form.round}
        method="post"
        onSubmit={form.onSubmit}
        onChange={form.onChange}
        className="divide-y divide-line border-t border-line"
      >
        <IssuerFields idPrefix="ruc-nuevo" issuer={null} />
        <FormFooter dirty={form.dirty} busy={form.busy} state={form.state} label="Dar de alta" />
      </form>
    </details>
  );
}

// ── Cuenta de cobro → RUC (MOM §35.2) ────────────────────────────────────────

function wordsOf(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * ¿Esta cuenta que ve el cliente es del titular de la cuenta de cobro? Kapta
 * reconoce el pago por el titular, no por el banco (MOM §35.2): un Yape y una
 * transferencia al mismo titular van con la misma fila. Encaja si el titular es
 * el mismo nombre escrito distinto («Grupo GF SAC» = «Grupo GF S.A.C.»), o si
 * todas sus palabras están en el nombre o en un alias de la cuenta.
 */
function sameHolder(holder: string, account: InvoiceAccountView): boolean {
  const names = [account.label, ...account.aliases];
  const key = statementAccountKey(holder);
  if (!key) return false;
  if (names.some((n) => statementAccountKey(n) === key)) return true;
  const want = wordsOf(holder);
  return want.length > 0 && names.some((n) => {
    const have = new Set(wordsOf(n));
    return want.every((w) => have.has(w));
  });
}

/** «···309» para un celular, como las cuentas de cobro; «···0-12» para lo demás. */
function accountTail(account: string): string {
  const compact = account.replace(/\s+/g, "");
  return /^\d{9}$/.test(compact) ? `···${compact.slice(-3)}` : `···${compact.slice(-4)}`;
}

function AccountRow({
  storeId,
  account: a,
  issuers,
  methods,
}: {
  storeId: string;
  account: InvoiceAccountView;
  issuers: InvoiceIssuerView[];
  methods: InvoicePaymentMethod[];
}) {
  const [value, setValue] = useState(a.issuerId ?? "");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<SettingsState>(initial);
  const router = useRouter();
  // Lo guardado manda cuando llega el refresco (o lo cambió otra pestaña). No va
  // en la `key`: volver a montar la fila borraría lo que respondió el servidor.
  useEffect(() => setValue(a.issuerId ?? ""), [a.issuerId]);
  const covers = methods.filter((m) => sameHolder(m.holder, a)).map((m) => `${m.label} ${accountTail(m.account)}`);
  const selectId = `cuenta-ruc-${a.id}`;
  const unknownIssuer = value !== "" && !issuers.some((i) => i.id === value);

  function change(next: string) {
    const prev = value;
    setValue(next);
    start(async () => {
      const res = await setAccountInvoiceIssuer(storeId, a.id, next);
      if (res.error) setValue(prev);
      setMsg(res);
      if (!res.error) router.refresh();
    });
  }

  return (
    <li className={cn(ROW, "flex flex-wrap items-start gap-x-4 gap-y-3")}>
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-sm font-semibold leading-5 text-ink-900">
          {a.label}{" "}
          <span className="font-normal tabular-nums text-ink-500">
            · {a.phoneLastDigits ? `···${a.phoneLastDigits}` : "Flow (sin celular)"}
          </span>
        </p>
        <p className="mt-0.5 text-[13px] leading-5 text-ink-500">
          {covers.length
            ? `Cubre: ${covers.join(", ")}`
            : a.phoneLastDigits
              ? "Ninguna cuenta que ve el cliente tiene este titular."
              : // La pasarela no se le enseña a la clienta: entra por el link o por la web (MOM §35.2).
                "Cubre: los pagos por link de Flow y el prepago web de la tienda."}
        </p>
      </div>
      <div className="w-full min-w-0 sm:w-72">
        <label htmlFor={selectId} className="sr-only">
          RUC de {a.label}
        </label>
        <select
          id={selectId}
          value={value}
          disabled={pending}
          onChange={(e) => change(e.target.value)}
          className={cn(FIELD, "pointer-coarse:h-11")}
        >
          <option value="">Sin comprobante</option>
          {issuers.map((i) => (
            <option key={i.id} value={i.id}>
              {i.legalName} · {i.ruc}
            </option>
          ))}
          {unknownIssuer && <option value={value}>Un RUC que ya no está</option>}
        </select>
        <p role="status" className="mt-1 min-h-5 text-[13px] leading-5">
          {pending ? (
            <span className="text-ink-500">Guardando…</span>
          ) : msg.error ? (
            <span className="text-crit-fg">{msg.error}</span>
          ) : msg.notice ? (
            <span className="text-ok-fg">{msg.notice}</span>
          ) : null}
        </p>
      </div>
    </li>
  );
}

// ── Últimos comprobantes ─────────────────────────────────────────────────────

const RECENT_COLS = "sm:grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,1.3fr)_7.5rem_minmax(0,1fr)_5.5rem]";

/** La acción no llegó, no volvió o volvió sin decir nada: pudo haber salido. */
const EMIT_LOST =
  "No se pudo completar la acción. Antes de intentar de nuevo, abre el pedido: si quedó «Emitiendo» o «En duda», búscala en SimpleFact.";

/** Lo que contestó «Emitir» para un pedido, y en qué fila se pulsó. */
export interface RecentEmitOutcome {
  /** La fila donde se pulsó: la respuesta se queda ahí mientras siga en la lista. */
  rowId: string;
  orderId: string;
  orderName: string | null;
  state: EmitInvoiceState;
}

/**
 * Lo que contestó cada «Emitir», por pedido. Vive en la lista y no en el botón
 * (revisión del 15-10-2026): después de emitir la página se refresca, y
 * el pedido ya no lleva oferta —tiene una real viva, o el RUC se apagó—. Cuando
 * la respuesta vivía dentro del botón, se desmontaba con él en cuanto llegaba
 * el refresco, y con ella las instrucciones de un «En duda» («búscala por su
 * nota antes de nada»), el «Ver PDF» o el motivo del error.
 */
export type RecentEmitOutcomes = Readonly<Record<string, RecentEmitOutcome>>;

/**
 * Los últimos comprobantes, con su «Emitir» (owner, 15-10-2026): la misma
 * acción, la misma confirmación y los mismos candados que «Emitir esta boleta»
 * del drawer, con lo mismo que confirmaría el drawer (`emitNow`: el RUC y el
 * total de ahora).
 *
 * Lo que contesta se guarda por pedido (`RecentEmitOutcomes`) y se enseña haya
 * o no oferta; después la página se refresca. Con una respuesta a la vista el
 * botón de ese pedido no vuelve: para intentar otra vez, se abre el pedido.
 * Siempre montada, aunque el refresco no haya podido leer la lista: si no, la
 * respuesta se perdía justo ahí.
 *
 * NUNCA DOS ENVÍOS DEL MISMO PEDIDO desde aquí. El candado del botón
 * (`sendOnce`) es del botón: si el refresco lo desmonta y lo vuelve a montar
 * mientras la acción sigue en vuelo, el nuevo nace suelto. Este candado es de
 * la lista, por pedido, y dura hasta que vuelve la respuesta.
 */
function RecentList({
  rows,
  issuers,
  canEmit,
  emitHere,
}: {
  /** null: no se pudo leer. */
  rows: InvoiceRecentView[] | null;
  /** Los RUC de la organización: la razón social y el modo de cada uno. */
  issuers: InvoiceIssuerView[];
  /** Quien mira tiene «Boletas y facturas». */
  canEmit: boolean;
  /** Este despliegue emite (producción). */
  emitHere: boolean;
}) {
  const [outcomes, setOutcomes] = useState<RecentEmitOutcomes>({});
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set());
  const inFlight = useRef(new Set<string>());
  const [refreshing, startRefresh] = useTransition();
  const router = useRouter();

  async function emit(row: InvoiceRecentView, offer: InvoicePanelEmitNow, simplefactChecked: boolean) {
    const orderId = row.orderId;
    if (inFlight.current.has(orderId)) return;
    inFlight.current.add(orderId);
    setSending((prev) => new Set(prev).add(orderId));
    let res: EmitInvoiceState;
    try {
      // La casilla «Revisé en SimpleFact…» de un pedido pagado antes de «Emitir
      // desde» viaja como en el drawer: el servidor la vuelve a exigir.
      res = await emitInvoiceAction(orderId, { issuerId: offer.issuerId, total: offer.total, simplefactChecked });
    } catch {
      // La acción no llegó o no volvió: pudo haber salido. Se dice así.
      res = { error: EMIT_LOST };
    }
    // Una respuesta sin aviso ni error no se pinta: no se sabe qué pasó.
    if (!res?.error && !res?.notice) res = { error: EMIT_LOST };
    setOutcomes((prev) => ({ ...prev, [orderId]: { rowId: row.id, orderId, orderName: row.orderName, state: res } }));
    inFlight.current.delete(orderId);
    setSending((prev) => {
      const next = new Set(prev);
      next.delete(orderId);
      return next;
    });
    startRefresh(() => router.refresh());
  }

  return (
    <RecentListView
      rows={rows}
      issuers={issuers}
      canEmit={canEmit}
      emitHere={emitHere}
      outcomes={outcomes}
      sending={sending}
      pending={refreshing}
      onEmit={emit}
    />
  );
}

/**
 * Dónde va cada respuesta: en la fila donde se pulsó; si ya no está entre las
 * 20 (la real nueva la empujó fuera), en la más nueva de su pedido; y si
 * ninguna de su pedido está, o la lista no se pudo leer, arriba, con el pedido
 * (`orphans`). Nunca se pierde una.
 */
function placeOutcomes(
  rows: readonly InvoiceRecentView[],
  outcomes: RecentEmitOutcomes,
): { byRow: Map<string, RecentEmitOutcome>; orphans: RecentEmitOutcome[] } {
  const byRow = new Map<string, RecentEmitOutcome>();
  const orphans: RecentEmitOutcome[] = [];
  for (const outcome of Object.values(outcomes)) {
    // Del más nuevo al más viejo: la primera de su pedido es la más nueva.
    const host = rows.find((r) => r.id === outcome.rowId) ?? rows.find((r) => r.orderId === outcome.orderId);
    if (host) byRow.set(host.id, outcome);
    else orphans.push(outcome);
  }
  return { byRow, orphans };
}

/** La lista con lo que ya contestó cada «Emitir». Separada para pintarla en las pruebas. */
export function RecentListView({
  rows,
  issuers,
  canEmit,
  emitHere,
  outcomes,
  sending,
  pending,
  onEmit,
}: {
  rows: InvoiceRecentView[] | null;
  issuers: InvoiceIssuerView[];
  canEmit: boolean;
  emitHere: boolean;
  outcomes: RecentEmitOutcomes;
  /** Pedidos con un «Emitir» en vuelo: su botón no sale otra vez. */
  sending: ReadonlySet<string>;
  /** La página se está refrescando. */
  pending: boolean;
  /** `simplefactChecked`: la casilla de un pedido pagado antes de «Emitir desde». */
  onEmit: (row: InvoiceRecentView, offer: InvoicePanelEmitNow, simplefactChecked: boolean) => Promise<void>;
}) {
  const { byRow, orphans } = placeOutcomes(rows ?? [], outcomes);
  const orphanList = orphans.length ? (
    <ul className="divide-y divide-line">
      {orphans.map((o) => (
        <li key={o.orderId} className="space-y-1 px-4 py-3 text-sm sm:px-5">
          <OrderLink orderId={o.orderId} className="font-medium text-brand-700 hover:underline">
            {o.orderName ?? "Ver pedido"}
          </OrderLink>
          <EmitOutcome state={o.state} />
        </li>
      ))}
    </ul>
  ) : null;

  if (rows === null || rows.length === 0) {
    return (
      <>
        {orphanList}
        <EmptyRow>
          {rows === null
            ? "No se pudieron leer los comprobantes."
            : "Todavía no hay comprobantes: con los RUC apagados no se revisa ni se emite nada."}
        </EmptyRow>
      </>
    );
  }

  return (
    <>
      {orphanList}
      <div
        aria-hidden
        className={cn("hidden gap-x-4 px-4 py-2.5 text-xs font-semibold leading-4 text-ink-600 sm:grid sm:px-5", RECENT_COLS)}
      >
        <span>Fecha</span>
        <span>Pedido</span>
        <span>RUC · modo</span>
        <span>Estado</span>
        <span>Comprobante</span>
        <span className="text-right">Total</span>
      </div>
      <ul className="divide-y divide-line sm:border-t sm:border-line">
        {rows.map((r) => (
          <li key={r.id} className={cn("grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:px-5", RECENT_COLS)}>
            <span className="whitespace-nowrap tabular-nums text-ink-700">{when(r.createdAt)}</span>
            <span className="min-w-0 truncate">
              <OrderLink orderId={r.orderId} className="font-medium text-brand-700 hover:underline">
                {r.orderName ?? "Ver pedido"}
              </OrderLink>
            </span>
            <span className="min-w-0 tabular-nums text-ink-700">
              {r.ruc} <span className="text-ink-500">· {INVOICE_MODE_LABEL[r.mode] ?? r.mode}</span>
            </span>
            <span className="flex flex-wrap items-center gap-1">
              {/* Una emitida con otro RUC no es una emitida «bien»: va en rojo y marcada. */}
              <Badge tone={r.rucMismatch ? "crit" : STATUS_TONE[r.status] ?? "neutral"}>
                {INVOICE_STATUS_LABEL[r.status] ?? r.status}
              </Badge>
              {r.rucMismatch && <Badge tone="crit">Otro RUC</Badge>}
            </span>
            <span className="tabular-nums text-ink-700">
              {r.serie && r.correlative ? `${r.serie}-${r.correlative}` : "—"}
            </span>
            <span className="tabular-nums text-ink-900 sm:text-right">S/ {r.total.toFixed(2)}</span>
            {r.rucMismatch ? (
              // Lo emitido no se toca (§2, principio 6): lo revisa una persona en SimpleFact.
              <p className="text-[13px] leading-5 text-crit-fg sm:col-span-full">
                {r.error ?? "SimpleFact la emitió con otro RUC."} Revísala en SimpleFact: puede necesitar anularse o
                una nota de crédito.
              </p>
            ) : (
              (r.status === "error" || r.status === "en_duda") &&
              r.error && (
                <p
                  className={cn("text-[13px] leading-5 sm:col-span-full", r.status === "error" ? "text-crit-fg" : "text-warn-fg")}
                >
                  {r.error}
                </p>
              )
            )}
            {(() => {
              // Lo que contestó «Emitir» va primero y no depende de la oferta:
              // después de emitir, el refresco la quita.
              const outcome = byRow.get(r.id);
              if (outcome) {
                return (
                  <div className="sm:col-span-full">
                    <EmitOutcome state={outcome.state} />
                  </div>
                );
              }
              // El botón: solo en una producción, en una simulada que la página
              // marcó (el drawer ofrecería el botón), de un RUC que sigue en
              // «Manual» en lo que se ve, solo a quien gestiona y sin una
              // respuesta de su pedido a la vista.
              const offer = r.emitNow;
              const issuer = offer ? issuers.find((i) => i.id === offer.issuerId) : undefined;
              const show =
                canEmit &&
                emitHere &&
                !!offer &&
                r.status === "simulada" &&
                issuer?.mode === "manual" &&
                !outcomes[r.orderId];
              return show && offer ? (
                <div className="sm:col-span-full">
                  <EmitInvoiceControl
                    label="Emitir"
                    emit={offer}
                    pending={pending || sending.has(r.orderId)}
                    onEmit={(simplefactChecked) => onEmit(r, offer, simplefactChecked)}
                  />
                </div>
              ) : null;
            })()}
          </li>
        ))}
      </ul>
    </>
  );
}

// ── La sección ───────────────────────────────────────────────────────────────

const TITLE = "Boletas y facturas (SimpleFact)";

export function InvoiceSettingsSection({
  storeId,
  data,
  paymentMethods,
}: {
  storeId: string;
  data: InvoiceSettingsData;
  paymentMethods: InvoicePaymentMethod[];
}) {
  if (!data.canManage) {
    return (
      <SettingsSection id="boletas" title={TITLE}>
        <div className={CARD}>
          <EmptyRow>Lo configura quien tiene el permiso “Boletas y facturas” (solo lo da el owner).</EmptyRow>
        </div>
      </SettingsSection>
    );
  }

  const issuers = data.issuers;
  const real = issuers?.filter((i) => i.mode === "real").length ?? 0;
  const manual = issuers?.filter((i) => i.mode === "manual").length ?? 0;
  const sim = issuers?.filter((i) => i.mode === "simulacion").length ?? 0;
  const badge = !issuers ? undefined : real ? (
    <Badge tone="ok">En real</Badge>
  ) : manual ? (
    <Badge tone="brand">En manual</Badge>
  ) : sim ? (
    <Badge tone="info">En simulación</Badge>
  ) : (
    <Badge>Apagado</Badge>
  );
  const methods = paymentMethods.filter((m) => m.active);

  return (
    <SettingsSection
      id="boletas"
      title={TITLE}
      badge={badge}
      description={
        <>
          <p>
            La boleta la emite <strong>la empresa que recibió el pago</strong>, en su cuenta de SimpleFact: una por
            pedido, cuando lo validado cubre el total y hasta S/ 700. Cada RUC nace <strong>apagado</strong>; se
            prueba en Simulación, sus primeras boletas reales se emiten una a una en Manual y recién después pasa a
            Real, donde el barrido las emite solo.
          </p>
          <p>
            El RUC sale de la cuenta que recibió el dinero. Bajo cada cuenta se ven las{" "}
            <SectionLink to="cuentas">cuentas de cobro que ve el cliente</SectionLink> con ese titular.
          </p>
        </>
      }
    >
      {!issuers ? (
        <Banner tone="warn" role="status">
          <p>
            No se pudieron leer los RUC de la organización. Si la migración 0257 todavía no está aplicada, es eso; si
            no, recarga la página.
          </p>
        </Banner>
      ) : (
        <>
          <p className={HELP}>
            Los RUC son de la organización: valen para <strong>todas sus tiendas</strong>.
          </p>
          {issuers.length === 0 && (
            <div className={CARD}>
              <EmptyRow>Aún no hay RUC: ningún pedido lleva comprobante. Agrega el primero abajo.</EmptyRow>
            </div>
          )}
          {issuers.map((i) => (
            <IssuerCard key={i.id} storeId={storeId} issuer={i} />
          ))}
          <NewIssuerCard storeId={storeId} />

          <div className={cn(CARD, "divide-y divide-line")}>
            <CardHeader
              title="Cuenta de cobro → RUC (esta tienda)"
              description={
                <p>
                  Las cuentas contra las que Kapta verifica los comprobantes. Una cuenta en{" "}
                  <strong>Sin comprobante</strong> no emite: el dinero que entra ahí no es de ninguna empresa
                  emisora. Asignar un RUC no emite nada pagado antes de su «Emitir desde».
                </p>
              }
            />
            {data.accounts === null ? (
              <EmptyRow>No se pudieron leer las cuentas de esta tienda: recarga la página.</EmptyRow>
            ) : data.accounts.length === 0 ? (
              <EmptyRow>Esta tienda no tiene cuentas de cobro activas: ningún pago tiene a qué RUC ir.</EmptyRow>
            ) : (
              <RowList>
                {data.accounts.map((a) => (
                  <AccountRow
                    key={a.id}
                    storeId={storeId}
                    account={a}
                    issuers={issuers}
                    methods={methods}
                  />
                ))}
              </RowList>
            )}
          </div>
        </>
      )}

      <div className={CARD}>
        <CardHeader
          title="Últimos comprobantes de esta tienda"
          description="Los 20 más recientes, simulados y reales, en hora de Lima. El detalle de cada uno está en la ficha del pedido."
        />
        {/* Con un RUC en «Manual», en una vista previa se dice por qué no hay
            «Emitir», con la frase del drawer (`no_produccion`). */}
        {!data.emitHere && manual > 0 && (
          <p className={cn(ROW, "text-[13px] leading-5 text-ink-600")}>
            «Emitir» no está disponible: {INVOICE_REASON_LABEL.no_produccion}
          </p>
        )}
        {/* Siempre montada, también sin lista: guarda lo que contestó «Emitir». */}
        <RecentList rows={data.recent} issuers={issuers ?? []} canEmit={data.canManage} emitHere={data.emitHere} />
      </div>
    </SettingsSection>
  );
}
