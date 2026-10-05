"use client";

// Ajustes de una tienda, con el lenguaje de la configuración de Stripe en el
// mundo de operación (DESIGN.md): índice lateral fijo, grupos, secciones con
// su chapa de estado y tarjetas que se guardan cada una por su cuenta.

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, CHECKBOX, FIELD, OpsButton, opsButtonClass } from "@/components/ops-ui";
import {
  CARD,
  CardHeader,
  CodeLine,
  EmptyRow,
  Field,
  FieldGrid,
  HELP,
  HourRange,
  NUMBER_FIELD,
  NUMBER_NARROW,
  ROW,
  RowList,
  SettingsGroup,
  SettingsIndex,
  SettingsSection,
  TEXTAREA,
  ToggleRow,
  type IndexGroup,
} from "@/components/settings-ui";
import { IconAlert, IconArrowLeft, IconCheckCircle, IconChevronDown, IconCopy } from "@/components/icons";
import { copyLabel, useCopyToClipboard } from "@/components/copy-button";
import { STORE_STATUSES, STORE_STATUS_LABEL } from "@/lib/store-settings";
import type { MetaAdAccount, MetaConnectionProbe, StoreMetaAdAccount } from "@/lib/meta-marketing";
import {
  addPaymentMethod,
  addReplyTemplate,
  backfillStoreMetaInsights,
  deletePaymentMethod,
  deleteReplyTemplate,
  deleteDistrictCoverage,
  setPaymentMethodActive,
  setPrimaryYape,
  saveDistrictCoverage,
  generateAliclikWebhookSecret,
  generateKapsoWebhookSecret,
  setReplyTemplateActive,
  listStoreMetaAdAccounts,
  reRegisterWebhooks,
  saveMetaAdAccounts,
  sendTelegramTest,
  sendUrgentTelegramTest,
  findTelegramGroups,
  addEscalationStep,
  moveEscalationStep,
  removeEscalationStep,
  sendTransitQueueNow,
  testFlowclLink,
  syncAliclikCatalogNow,
  syncNow,
  testAliclikConnection,
  testStoreMetaConnection,
  testShalomConnection,
  findShalomAgencies,
  updateStore,
  type SettingsState,
} from "@/app/dashboard/[storeId]/settings/actions";

const initial: SettingsState = {};

export interface StoreSettingsData {
  store: {
    id: string;
    name: string;
    shopify_domain: string;
    currency: string;
    timezone: string;
    status: string;
    whatsapp_phone_number_id: string | null;
    kapso_project_id: string | null;
    order_prefix: string | null;
    browse_template_enabled: boolean;
    browse_template_name: string | null;
    browse_template_language: string | null;
    winback_template_enabled: boolean;
    winback_template_name: string | null;
    winback_template_language: string | null;
    drip_template_enabled: boolean;
    drip_template_name: string | null;
    drip_template_language: string | null;
    cart_seq_enabled: boolean;
    cart_seq_template_1_name: string | null;
    cart_seq_template_1_language: string | null;
    cart_seq_template_2_name: string | null;
    cart_seq_template_2_language: string | null;
    cart_seq_hours_1: number;
    cart_seq_hours_2: number;
    cart_seq_hour_start: number;
    cart_seq_hour_end: number;
    return_recovery_enabled: boolean;
    return_recovery_auto: boolean;
    return_recovery_template_name: string | null;
    return_recovery_template_language: string | null;
    return_recovery_params: string | null;
    return_recovery_phone_number_id: string | null;
    return_recovery_hour_start: number;
    return_recovery_hour_end: number;
    return_recovery_max_days: number;
    delivered_thanks_enabled: boolean;
    delivered_thanks_template_name: string | null;
    delivered_thanks_template_language: string | null;
    delivered_thanks_params: string | null;
    delivered_thanks_button_param: string | null;
    delivered_thanks_phone_number_id: string | null;
    delivered_thanks_hour_start: number;
    delivered_thanks_hour_end: number;
    delivered_thanks_max_hours: number;
    delivered_thanks_pace_count: number;
    delivered_thanks_pace_minutes: number;
    /** Agente de voz para Reproprovincia (MOM §11.8, migración 0190). */
    voice_recovery_enabled: boolean;
    voice_recovery_auto: boolean;
    voice_recovery_can_discard: boolean;
    voice_recovery_daily_cap: number;
    voice_recovery_max_attempts: number;
    voice_recovery_max_age_days: number;
    voice_recovery_hour_start: number;
    voice_recovery_hour_end: number;
    voice_recovery_agent_number: string | null;
    voice_recovery_zadarma_sip: string | null;
    /** Ciclo de recontacto en confirmación (MOM §6.1, migración 0133). */
    confirmation_cycle_days: number;
    telegram_chat_id: string | null;
    /** Grupo de alertas urgentes (0226). */
    urgent_telegram_chat_id: string | null;
    anthropic_model: string | null;
    aliclik_enabled: boolean;
    tanders_email: string | null;
    tanders_origin_address: string | null;
    tanders_origin_lat: number | null;
    tanders_origin_lng: number | null;
    shalom_pro_email: string | null;
    shalom_origin_terminal_id: number | null;
    shalom_origin_terminal_name: string | null;
    shalom_default_product_id: number | null;
    /** Aviso de guía en tránsito (0166). */
    shalom_transit_template_enabled: boolean;
    shalom_transit_template_name: string | null;
    shalom_transit_template_language: string | null;
    shalom_transit_params: string | null;
    shalom_transit_attach_ticket: boolean;
    shalom_transit_phone_number_id: string | null;
    shalom_transit_hour_start: number;
    shalom_notice_daily_cap: number;
    shalom_notice_hourly_cap: number;
    shalom_transit_hour_end: number;
    shalom_transit_payment_link: string | null;
    shalom_arrival_template_enabled: boolean;
    shalom_arrival_template_name: string | null;
    shalom_arrival_params: string | null;
    shalom_arrival_attach_ticket: boolean;
    shalom_voucher_intake_enabled: boolean;
    shalom_pickup_key_autosend_enabled: boolean;
    /** Los dos avisos de Olva (0175). */
    olva_transit_template_enabled: boolean;
    olva_transit_template_name: string | null;
    olva_transit_params: string | null;
    olva_arrival_template_enabled: boolean;
    olva_arrival_template_name: string | null;
    olva_arrival_params: string | null;
    /** Portal de clientes de Olva, para «Cotejar Olva» (0218). */
    olva_portal_username: string | null;
    olva_portal_ruc: string | null;
    flowcl_link_enabled: boolean;
    flowcl_link_email: string | null;
    flowcl_link_ttl_hours: number;
    flowcl_link_yape_only: boolean;
    meta_ad_accounts: StoreMetaAdAccount[];
  };
  has: {
    shopifyToken: boolean;
    webhookSecret: boolean;
    kapsoKey: boolean;
    flowSecret: boolean;
    kapsoWebhookSecret: boolean;
    flowclApiKey: boolean;
    flowclSecretKey: boolean;
    flowclWebhookSecret: boolean;
    telegramToken: boolean;
    metaToken: boolean;
    anthropicKey: boolean;
    aliclikToken: boolean;
    aliclikWebhookSecret: boolean;
    tandersPassword: boolean;
    shalomProPassword: boolean;
    olvaPortalPassword: boolean;
  };
  oauthAvailable: boolean;
  siteUrl: string;
  sync: Array<{
    source: string;
    status: string | null;
    last_run_at: string | null;
    cursor: string | null;
    error: string | null;
  }>;
  lastOpsAt: string | null;
  webhookCount: number;
  webhookEvents: Array<{
    id: string;
    topic: string;
    shopify_id: string | null;
    received_at: string;
    processed: boolean;
    error: string | null;
  }>;
  /** Catálogo de plantillas que el asesor puede enviar con la ventana cerrada
   *  (0113). Vacío mientras la migración no esté aplicada. */
  /** Cuentas de cobro que se le enseñan al cliente (0166). */
  paymentMethods: Array<{
    id: string;
    kind: string;
    label: string;
    holder: string;
    account: string;
    detail: string | null;
    primary_yape: boolean;
    active: boolean;
    sort: number;
  }>;
  /** La escalera de la cola de cobranza (0172), en orden. */
  escalation: Array<{ id: string; userId: string; name: string; minutes: number; sort: number }>;
  /** Usuarios de la tienda que pueden entrar en la escalera. */
  escalationCandidates: Array<{ id: string; name: string }>;
  replyTemplates: Array<{
    id: string;
    label: string;
    template_name: string;
    language: string;
    body_preview: string | null;
    params: string;
    active: boolean;
    sort: number;
  }>;
  /** Excepciones de cobertura por distrito (0121). Vacío = manda la regla
   *  general; es el estado normal, no una configuración pendiente. */
  districtCoverage: Array<{
    id: string;
    store_id: string | null;
    district: string;
    coverage: string;
    note: string | null;
    updated_at: string;
  }>;
}


/** Nombre legible del tipo de webhook en el registro de recibidos. */
function webhookTopicLabel(topic: string): string {
  if (topic === "flow/abandoned_browse") return "Búsqueda abandonada";
  if (topic === "flow/unauthorized") return "Rechazado (secreto)";
  if (topic === "flow/bad_request") return "Payload inválido";
  if (topic.startsWith("draft_orders/")) return "Borrador (carrito)";
  if (topic.startsWith("orders/")) return "Orden";
  return topic;
}

/** El índice de la página: el orden de los grupos y secciones de abajo. */
const INDEX: IndexGroup[] = [
  {
    title: "General",
    items: [
      { id: "tienda", label: "Tienda" },
      { id: "confirmacion", label: "Ciclo de confirmación" },
      { id: "cobertura", label: "Cobertura por distrito" },
    ],
  },
  {
    title: "Conexiones",
    items: [
      { id: "shopify", label: "Shopify" },
      { id: "kapso", label: "Kapso" },
      { id: "aliclik", label: "Aliclik" },
      { id: "shalom", label: "Shalom" },
      { id: "olva", label: "Olva" },
      { id: "tanders", label: "Tanders" },
      { id: "flowcl", label: "Flow.cl" },
      { id: "meta", label: "Meta Ads" },
      { id: "telegram", label: "Telegram" },
      { id: "comprobantes", label: "Lectura de comprobantes" },
    ],
  },
  {
    title: "Mensajes automáticos",
    items: [
      { id: "busqueda", label: "Búsqueda abandonada" },
      { id: "recuperacion", label: "Clientes sin comprar" },
      { id: "drip", label: "Drip sin respuesta" },
      { id: "carritos", label: "Carritos abandonados" },
      { id: "agradecer", label: "Agradecer al entregar" },
      { id: "devueltos", label: "Pedidos devueltos" },
      { id: "agente-voz", label: "Agente de voz" },
      { id: "avisos-shalom", label: "Avisos de Shalom" },
      { id: "avisos-olva", label: "Avisos de Olva" },
      { id: "plantillas", label: "Plantillas de respuesta" },
    ],
  },
  {
    title: "Cobranza",
    items: [
      { id: "cuentas", label: "Cuentas de cobro" },
      { id: "escalera", label: "Quién atiende la cobranza" },
    ],
  },
  {
    title: "Sistema",
    items: [
      { id: "sincronizacion", label: "Sincronización" },
      { id: "webhooks", label: "Webhooks recibidos" },
    ],
  },
];

/** El nombre de una fuente de sincronización (`shopify_all` → «Shopify all»). */
function sourceLabel(source: string): string {
  const words = source.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Enlace a otra sección de esta misma página. */
function SectionLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a href={`#${to}`} className="font-medium text-brand-700 hover:underline">
      {children}
    </a>
  );
}

/** La chapa de una automatización: encendida o apagada, con palabras. */
function OnOff({ on, onLabel = "Activo", offLabel = "Apagado" }: { on: boolean; onLabel?: string; offLabel?: string }) {
  return <Badge tone={on ? "ok" : "neutral"}>{on ? onLabel : offLabel}</Badge>;
}

export function StoreSettings({
  data,
  banner,
}: {
  data: StoreSettingsData;
  banner?: { kind: "ok" | "error"; msg: string } | null;
}) {
  const s = data.store;
  const has = data.has;
  return (
    <div className="mx-auto max-w-[76rem] [&_code]:rounded [&_code]:bg-line [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-ink-700">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Ajustes</h1>
          <p className="mt-1 text-sm text-ink-500">
            {s.name} · {s.shopify_domain}
          </p>
        </div>
        <Link href={`/dashboard/${s.id}`} className={opsButtonClass("secondary", "md", "pointer-coarse:h-11")}>
          <IconArrowLeft />
          Volver al panel
        </Link>
      </header>

      {banner && (
        <Banner tone={banner.kind === "ok" ? "ok" : "crit"} role={banner.kind === "ok" ? "status" : "alert"} className="mt-6">
          {banner.msg}
        </Banner>
      )}

      <div className="mt-8">
        <SettingsIndex groups={INDEX}>
          <SettingsGroup title="General">
            <SettingsSection id="tienda" title="Tienda">
              <StoreForm storeId={s.id} persisted={[s.name, s.status, s.currency, s.timezone, s.order_prefix]}>
                <FieldGrid>
                  <Field label="Nombre" htmlFor="name">
                    <input id="name" name="name" defaultValue={s.name} className={FIELD} />
                  </Field>
                  <Field label="Estado" htmlFor="status">
                    <select id="status" name="status" defaultValue={s.status} className={FIELD}>
                      {STORE_STATUSES.map((st) => (
                        <option key={st} value={st}>
                          {STORE_STATUS_LABEL[st] ?? st}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Moneda" htmlFor="currency">
                    <input id="currency" name="currency" defaultValue={s.currency} className={FIELD} />
                  </Field>
                  <Field label="Zona horaria" htmlFor="timezone">
                    <input id="timezone" name="timezone" defaultValue={s.timezone} className={FIELD} />
                  </Field>
                  <Field
                    label="Prefijo de los pedidos"
                    htmlFor="order_prefix"
                    className="sm:col-span-2"
                    hint={
                      <p>
                        Sin el <code>#</code>, como en <code>#KP114985</code> → <code>KP</code>. Cuando el
                        reporte de Aliclik trae el número de pedido pelado en la NOTA, es lo que lo completa —
                        y con eso <strong>en qué tienda se busca</strong> ese pedido. Vacío: no se adivina
                        ningún pedido a partir de un número suelto.
                      </p>
                    }
                  >
                    <input
                      id="order_prefix"
                      name="order_prefix"
                      defaultValue={s.order_prefix ?? ""}
                      placeholder="KP"
                      className={cn(FIELD, "sm:max-w-48")}
                    />
                  </Field>
                </FieldGrid>
              </StoreForm>
            </SettingsSection>

            <SettingsSection
              id="confirmacion"
              title="Ciclo de confirmación"
              description={
                <p>
                  El mismo control vive en el Master de Pedidos, junto a los chips de{" "}
                  <strong>Fecha pactada</strong>, que es donde se ve su efecto. Aquí queda para dejar la
                  tienda configurada de entrada.
                </p>
              }
            >
              <StoreForm storeId={s.id} persisted={[s.confirmation_cycle_days]}>
                <div className={ROW}>
                  <Field
                    label="Ciclo de recontacto sin fecha pactada (días)"
                    htmlFor="confirmation_cycle_days"
                    hint={
                      <p>
                        Un pedido en <strong>Por confirmar</strong> que ya tuvo contacto y no dejó fecha
                        pactada vuelve a la cola de <strong>Hoy</strong> cada tantos días. No gasta días de
                        gestión: los siete del MOM siguen contando solo los días con intento real. Los que
                        nunca se contactaron («Sin llamar») no entran al ciclo.
                      </p>
                    }
                  >
                    <input
                      id="confirmation_cycle_days"
                      name="confirmation_cycle_days"
                      type="number"
                      min={1}
                      max={30}
                      defaultValue={s.confirmation_cycle_days}
                      className={cn(NUMBER_NARROW, "w-28")}
                    />
                  </Field>
                </div>
              </StoreForm>
            </SettingsSection>

            <DistrictCoverageSection storeId={s.id} rows={data.districtCoverage} />
          </SettingsGroup>

          <SettingsGroup
            title="Conexiones"
            description="Cuentas y credenciales con las que Kapta habla con cada servicio. Los secretos se guardan cifrados y no se vuelven a mostrar: déjalos en blanco para conservar el actual."
          >
            <ShopifySection data={data} />
            <KapsoSection data={data} />
            <AliclikSection
              siteUrl={data.siteUrl}
              storeId={s.id}
              hasToken={has.aliclikToken}
              hasSecret={has.aliclikWebhookSecret}
              enabled={s.aliclik_enabled}
            />
            <ShalomSection data={data} />
            <OlvaPortalSection data={data} />
            <TandersSection data={data} />
            <FlowclSection data={data} />
            <MetaSection data={data} />
            <TelegramSection data={data} />
            <ComprobantesSection data={data} />
          </SettingsGroup>

          <SettingsGroup
            title="Mensajes automáticos"
            description="Lo que Kapta manda o hace sola por WhatsApp y por teléfono. Cada plantilla tiene que estar aprobada por Meta con el mismo nombre e idioma."
          >
            <AutomationSections data={data} />
            <ReplyTemplatesSection storeId={s.id} rows={data.replyTemplates} />
          </SettingsGroup>

          <SettingsGroup title="Cobranza">
            <PaymentMethodsSection storeId={s.id} rows={data.paymentMethods} />
            <EscalationSection storeId={s.id} rows={data.escalation} candidates={data.escalationCandidates} />
          </SettingsGroup>

          <SettingsGroup title="Sistema">
            <SystemSections data={data} />
          </SettingsGroup>
        </SettingsIndex>
      </div>
    </div>
  );
}

/* ── Piezas compartidas ──────────────────────────────────────────────────── */

/**
 * Una tarjeta que guarda sus propios campos en la tienda.
 *
 * `updateStore` solo parchea los campos que llegan (lo que no viene, no se
 * toca), así que cada tarjeta manda los suyos y guardar una no pisa las demás.
 *
 * Se envía a mano (`onSubmit` + la acción dentro de una transición) y no con
 * `action={…}`, porque React 19 reinicia el formulario al terminar CUALQUIER
 * acción, también la que vuelve con error: el pie decía «no se pudo guardar»
 * mientras lo escrito ya había vuelto en silencio a lo persistido. Así, con
 * error lo escrito se queda; con éxito se refresca la página y, cuando el
 * refresco ya llegó, se reinicia la tarjeta (vacía las credenciales y repone lo
 * que el servidor no aceptó).
 *
 * La `key` del <form> es lo PERSISTIDO de esos campos. Un campo NO controlado
 * conserva el `defaultValue` que tenía AL MONTARSE: cambiar la prop no mueve la
 * selección del DOM, y «Crear guías en Aliclik» se guardaba en la base mientras
 * la pantalla seguía pintando el valor viejo. Volver a montarlo cuando cambia
 * lo persistido (y solo entonces) aplica de nuevo cada `defaultValue`. Va por
 * tarjeta y no de toda la página: guardar una no tira lo que se está
 * escribiendo en otra.
 */
function StoreForm({
  storeId,
  persisted,
  title,
  description,
  children,
}: {
  storeId: string;
  persisted: unknown[];
  title?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const [state, action, pending] = useActionState(updateStore, initial);
  const [, startSave] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const [dirty, setDirty] = useState(false);
  // Hasta que la página carga su JavaScript, el formulario no tiene quién lo
  // envíe a mano: un Enter haría el envío nativo del navegador. Con «Guardar»
  // apagado hasta entonces no hay envío implícito, y `method="post"` evita que,
  // si lo hubiera, las credenciales viajen en la URL.
  const [ready, setReady] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const resetAfterRefresh = useRef(false);
  // Lo escrito mientras se guardaba no lo ha visto el servidor: el reinicio de
  // después lo borraría sin avisar.
  const editedDuringSave = useRef(false);
  const router = useRouter();

  useEffect(() => setReady(true), []);

  // Guardado: la acción revalida la ruta, pero la tarjeta se queda con lo que
  // tenía montado; el refresco trae lo persistido y, con ello, la `key`.
  useEffect(() => {
    if (state === initial || state.error) return;
    resetAfterRefresh.current = true;
    startRefresh(() => router.refresh());
  }, [router, state]);

  useEffect(() => {
    if (refreshing || !resetAfterRefresh.current) return;
    resetAfterRefresh.current = false;
    if (!editedDuringSave.current) form.current?.reset();
  }, [refreshing]);

  return (
    <form
      key={JSON.stringify(persisted)}
      ref={form}
      method="post"
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        editedDuringSave.current = false;
        setDirty(false);
        startSave(() => action(data));
      }}
      onChange={() => {
        editedDuringSave.current = true;
        setDirty(true);
      }}
      onReset={() => setDirty(false)}
      className={cn(CARD, "divide-y divide-line")}
    >
      <input type="hidden" name="store_id" value={storeId} />
      {title && <CardHeader title={title} description={description} />}
      {children}
      <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
        <p role="status" className="mr-auto min-w-0 text-[13px] leading-5">
          <SaveStatus dirty={dirty} pending={pending || refreshing} state={state} />
        </p>
        <OpsButton type="submit" variant="primary" disabled={!ready || pending || refreshing}>
          {pending || refreshing ? "Guardando…" : "Guardar"}
        </OpsButton>
      </div>
    </form>
  );
}

function SaveStatus({ dirty, pending, state }: { dirty: boolean; pending: boolean; state: SettingsState }) {
  if (pending) return null;
  if (dirty) return <span className="font-medium text-ink-600">Cambios sin guardar</span>;
  if (state.error) {
    return (
      <span className="inline-flex items-start gap-1.5 text-crit-fg">
        <IconAlert className="mt-0.5 size-3.5 shrink-0" />
        {state.error}
      </span>
    );
  }
  if (state.notice === "Tienda actualizada.") {
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-ok-fg">
        <IconCheckCircle className="size-3.5 shrink-0" />
        Guardado
      </span>
    );
  }
  if (state.notice) return <span className="text-ink-600">{state.notice}</span>;
  return null;
}

/**
 * Credencial cifrada. Nunca se vuelve a leer: el campo va vacío, y vacío al
 * guardar significa «conserva la actual». La chapa dice si hay una guardada.
 */
function SecretField({
  name,
  label,
  set,
  hint,
  className,
}: {
  name: string;
  label: string;
  set: boolean;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <Field
      label={label}
      htmlFor={name}
      className={className}
      hint={hint}
      mark={<Badge tone={set ? "ok" : "neutral"}>{set ? "Configurado" : "Sin configurar"}</Badge>}
    >
      <input
        id={name}
        name={name}
        type="password"
        autoComplete="off"
        placeholder={set ? "Déjalo en blanco para conservarlo" : "Pega el valor"}
        className={FIELD}
      />
    </Field>
  );
}

/**
 * «Guardado» para un campo normal, con el mismo lenguaje que `SecretField`.
 *
 * Existe porque un `<input>` con un valor dentro no distingue entre «esto está
 * guardado en la base» y «esto es texto que escribí y todavía no he guardado» —
 * y el que configura una tienda necesita saberlo antes de irse de la pantalla.
 * Marca lo que hay EN LA BASE, así que sigue diciendo «guardado» mientras
 * editas encima; lo que confirma el guardado es el pie de la tarjeta.
 */
function SavedMark({ set }: { set: boolean }) {
  return <Badge tone={set ? "ok" : "neutral"}>{set ? "Guardado" : "Sin definir"}</Badge>;
}

/** Resultado de una acción de ajustes, respetando los saltos de línea. */
function ActionResult({ state, className }: { state: SettingsState; className?: string }) {
  if (!state.error && !state.notice) return null;
  return (
    <Banner tone={state.error ? "crit" : "ok"} role={state.error ? "alert" : "status"} className={className}>
      <p className="whitespace-pre-line break-words">{state.error ?? state.notice}</p>
    </Banner>
  );
}

/** Una acción de un clic que no guarda ajustes (sincronizar, probar, enviar). */
function ActionRow({
  action,
  storeId,
  title,
  label,
  pendingLabel = "Ejecutando…",
  help,
}: {
  action: (prev: SettingsState, fd: FormData) => Promise<SettingsState>;
  storeId: string;
  title: string;
  label: string;
  pendingLabel?: string;
  help: ReactNode;
}) {
  const [state, formAction, pending] = useActionState(action, initial);
  return (
    <form action={formAction} className={ROW}>
      <input type="hidden" name="store_id" value={storeId} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-sm font-semibold leading-5 text-ink-900">{title}</p>
          <div className={cn(HELP, "mt-0.5")}>{help}</div>
        </div>
        <OpsButton type="submit" disabled={pending}>
          {pending ? pendingLabel : label}
        </OpsButton>
      </div>
      <ActionResult state={state} className="mt-3" />
    </form>
  );
}

/** Botón de una acción que no guarda, para la cabecera de una sección. */
function SubmitAction({
  formAction,
  storeId,
  pending,
  disabled,
  label,
  pendingLabel,
}: {
  formAction: (fd: FormData) => void;
  storeId: string;
  pending: boolean;
  disabled?: boolean;
  label: string;
  pendingLabel: string;
}) {
  return (
    <form action={formAction}>
      <input type="hidden" name="store_id" value={storeId} />
      <OpsButton type="submit" size="sm" disabled={pending || disabled} className="pointer-coarse:h-11">
        {pending ? pendingLabel : label}
      </OpsButton>
    </form>
  );
}

/** Un bloque de campos con su propio título dentro de una tarjeta. */
function SubRow({ title, description, cols = 3, children }: { title: string; description?: ReactNode; cols?: 2 | 3; children: ReactNode }) {
  return (
    <div className={ROW}>
      <p className="text-sm font-semibold leading-5 text-ink-900">{title}</p>
      {description && <div className={cn(HELP, "mt-0.5")}>{description}</div>}
      <div className={cn("mt-3 grid gap-x-4 gap-y-5", cols === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2")}>
        {children}
      </div>
    </div>
  );
}

/** Un aviso como fila de la tarjeta. */
function BannerRow({ tone = "warn", title, children }: { tone?: "warn" | "info" | "crit"; title?: string; children: ReactNode }) {
  return (
    <div className={ROW}>
      <Banner tone={tone} title={title} className="[&_strong]:font-semibold [&_strong]:text-ink-900">
        {children}
      </Banner>
    </div>
  );
}

/* ── Conexiones ──────────────────────────────────────────────────────────── */

function ShopifySection({ data }: { data: StoreSettingsData }) {
  const s = data.store;
  const has = data.has;
  return (
    <SettingsSection
      id="shopify"
      title="Shopify"
      badge={<Badge tone={has.shopifyToken ? "ok" : "warn"}>{has.shopifyToken ? "Conectada" : "Sin token"}</Badge>}
      description={<p>Instala vía OAuth y el token se captura y cifra solo (sin copiar/pegar).</p>}
    >
      <div className={cn(CARD, "divide-y divide-line")}>
        {data.oauthAvailable ? (
          <div className={cn(ROW, "flex flex-wrap items-center justify-between gap-3")}>
            <div className="min-w-0 flex-1 basis-64">
              <p className="text-sm font-semibold leading-5 text-ink-900">Conexión con la tienda</p>
              <p className={cn(HELP, "mt-0.5")}>
                {has.shopifyToken
                  ? "Token configurado (cifrado)."
                  : "Aún sin token — instala para activar webhooks + backfill."}
              </p>
            </div>
            <a
              href={`/api/shopify/install?storeId=${s.id}`}
              className={opsButtonClass(has.shopifyToken ? "secondary" : "primary", "md", "pointer-coarse:h-11")}
            >
              {has.shopifyToken ? "Reconectar con Shopify" : "Instalar con Shopify"}
            </a>
          </div>
        ) : (
          <p className={cn(ROW, HELP)}>
            OAuth no está configurado en el servidor. Configura <code>SHOPIFY_APP_API_KEY</code> y{" "}
            <code>SHOPIFY_APP_API_SECRET</code>, o pega el token manualmente abajo.
          </p>
        )}
        <ActionRow
          action={reRegisterWebhooks}
          storeId={s.id}
          title="Webhooks de pedidos"
          label="Re-registrar webhooks"
          help="Vuelve a registrar orders/create y orders/updated apuntando a este panel."
        />
      </div>

      <StoreForm storeId={s.id} title="Credenciales" persisted={[has.shopifyToken, has.webhookSecret, has.flowSecret]}>
        <FieldGrid>
          <SecretField name="shopify_token" label="Shopify Admin API token" set={has.shopifyToken} />
          <SecretField name="shopify_webhook_secret" label="Shopify API secret (HMAC)" set={has.webhookSecret} />
          <SecretField
            name="flow_webhook_secret"
            label="Secreto webhook de Shopify Flow (búsquedas)"
            set={has.flowSecret}
            className="sm:col-span-2"
          />
        </FieldGrid>
      </StoreForm>
    </SettingsSection>
  );
}

function KapsoSection({ data }: { data: StoreSettingsData }) {
  const s = data.store;
  const has = data.has;
  const [state, action, pending] = useActionState(generateKapsoWebhookSecret, initial);
  const revealed = state.kapsoSecret ?? null;
  // Con un secreto recién acuñado se enseña la URL lista para pegar; si no, la
  // plantilla enmascarada (el texto plano no se puede volver a leer, a propósito).
  const url = revealed
    ? `${data.siteUrl}/api/webhooks/kapso/${s.id}?secret=${revealed}`
    : `${data.siteUrl}/api/webhooks/kapso/${s.id}?secret=${
        has.kapsoWebhookSecret ? "<TU_SECRETO_DE_ESTA_TIENDA>" : "<GENERA_EL_SECRETO_ABAJO>"
      }`;
  const { state: copied, copy } = useCopyToClipboard();
  return (
    <SettingsSection
      id="kapso"
      title="Kapso · WhatsApp"
      badge={
        <Badge tone={has.kapsoWebhookSecret ? "ok" : "warn"}>
          {has.kapsoWebhookSecret ? "Secreto propio" : "Sin secreto propio"}
        </Badge>
      }
      description={
        <p>
          Genera un secreto exclusivo de esta tienda y pega la URL resultante en los dos webhooks de Kapso.
          Así los leads de esta tienda quedan aislados de las demás.
        </p>
      }
    >
      <div className={cn(CARD, "divide-y divide-line")}>
        <CardHeader
          title="URL de los webhooks"
          description={
            has.kapsoWebhookSecret
              ? "Esta tienda tiene su propio secreto."
              : "Aún sin secreto propio — genera uno antes de conectar Kapso."
          }
          aside={
            <SubmitAction
              formAction={action}
              storeId={s.id}
              pending={pending}
              label={has.kapsoWebhookSecret ? "Regenerar secreto" : "Generar secreto"}
              pendingLabel="Generando…"
            />
          }
        />
        <div className={cn(ROW, "space-y-3")}>
          <ActionResult state={state.error ? state : {}} />
          {revealed ? (
            <Banner tone="ok" role="status" title="Secreto generado. Cópialo ahora — no se vuelve a mostrar.">
              <CodeLine className="mt-2 bg-white">{revealed}</CodeLine>
              <p className="mt-2">
                Regenerar invalida el anterior: recuerda actualizar la URL en los dos webhooks de Kapso.
              </p>
            </Banner>
          ) : null}
          <div className="flex flex-wrap items-stretch gap-2">
            <CodeLine>{url}</CodeLine>
            {revealed ? (
              <OpsButton onClick={() => copy(url)} className="h-auto min-h-9">
                <IconCopy />
                {copyLabel(copied)}
              </OpsButton>
            ) : null}
          </div>
          <p className={HELP}>
            El <code>store id</code> de esta tienda ya viene en la URL: <code>{s.id}</code>. No es el Project ID
            de Kapso.
          </p>
        </div>
        <div className="grid divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          <div className={ROW}>
            <p className="text-sm font-semibold leading-5 text-ink-900">WhatsApp webhook → abandonos</p>
            <p className={cn(HELP, "mt-1")}>
              Integrations → Webhooks → tu número. Marca <strong>Conversation ended</strong> y{" "}
              <strong>Conversation inactive</strong>. Deja el <em>signing secret</em> en blanco.
            </p>
          </div>
          <div className={ROW}>
            <p className="text-sm font-semibold leading-5 text-ink-900">Platform webhook → leads</p>
            <p className={cn(HELP, "mt-1")}>
              Integrations → Webhooks → pestaña <strong>Platform webhooks</strong>. Marca{" "}
              <strong>workflow.execution.handoff</strong>.
            </p>
          </div>
        </div>
      </div>

      <StoreForm
        storeId={s.id}
        title="Identificadores y credenciales"
        persisted={[s.whatsapp_phone_number_id, s.kapso_project_id, has.kapsoKey, has.kapsoWebhookSecret]}
      >
        <FieldGrid>
          <Field label="WhatsApp phone number id" htmlFor="whatsapp_phone_number_id">
            <input
              id="whatsapp_phone_number_id"
              name="whatsapp_phone_number_id"
              defaultValue={s.whatsapp_phone_number_id ?? ""}
              className={FIELD}
            />
          </Field>
          <Field label="Kapso project id" htmlFor="kapso_project_id">
            <input id="kapso_project_id" name="kapso_project_id" defaultValue={s.kapso_project_id ?? ""} className={FIELD} />
          </Field>
          <SecretField name="kapso_api_key" label="Kapso API key" set={has.kapsoKey} />
          <SecretField name="kapso_webhook_secret" label="Secreto webhook de Kapso (leads)" set={has.kapsoWebhookSecret} />
        </FieldGrid>
      </StoreForm>
    </SettingsSection>
  );
}

/**
 * Aliclik: token de integración, webhook de estados e interruptor de escritura.
 *
 * El webhook de Aliclik NO viene firmado —su documentación no define ni HMAC ni
 * cabecera de autenticación— así que el secreto en la URL es la única barrera.
 * De ahí que se acuñe igual que el de Kapso y se revele una sola vez.
 */
function AliclikSection({
  siteUrl,
  storeId,
  hasToken,
  hasSecret,
  enabled,
}: {
  siteUrl: string;
  storeId: string;
  hasToken: boolean;
  hasSecret: boolean;
  enabled: boolean;
}) {
  const [secretState, secretAction, secretPending] = useActionState(generateAliclikWebhookSecret, initial);
  const [testState, testAction, testPending] = useActionState(testAliclikConnection, initial);
  const [syncState, syncAction, syncPending] = useActionState(syncAliclikCatalogNow, initial);
  const revealed = secretState.aliclikSecret ?? null;
  const url = revealed
    ? `${siteUrl}/api/webhooks/aliclik/${storeId}?secret=${revealed}`
    : `${siteUrl}/api/webhooks/aliclik/${storeId}?secret=${
        hasSecret ? "<TU_SECRETO_DE_ESTA_TIENDA>" : "<GENERA_EL_SECRETO_ABAJO>"
      }`;
  const { state: copied, copy } = useCopyToClipboard();

  return (
    <SettingsSection
      id="aliclik"
      title="Aliclik"
      badge={
        !hasToken ? (
          <Badge>Sin token</Badge>
        ) : (
          <OnOff on={enabled} onLabel="Creación de guías activada" offLabel="Creación de guías desactivada" />
        )
      }
      description={
        <p>
          Permite crear el pedido en Aliclik desde el Master, en vez de cargarlo a mano en su panel. El token lo
          entrega el equipo de Aliclik tras el alta como integrador.
        </p>
      }
      actions={
        <>
          <SubmitAction
            formAction={testAction}
            storeId={storeId}
            pending={testPending}
            disabled={!hasToken}
            label="Probar conexión"
            pendingLabel="Probando…"
          />
          <SubmitAction
            formAction={syncAction}
            storeId={storeId}
            pending={syncPending}
            disabled={!hasToken}
            label="Sincronizar catálogo"
            pendingLabel="Sincronizando…"
          />
        </>
      }
    >
      {/* `whitespace-pre-line` en ActionResult: el resultado de la prueba
          compara las dos salidas en líneas separadas, y sin eso se leería como
          un párrafo corrido justo cuando importa distinguirlas. */}
      <ActionResult state={testState} />
      <ActionResult state={syncState} />

      <StoreForm storeId={storeId} title="Integración" persisted={[hasToken, enabled]}>
        <div className={ROW}>
          <SecretField
            name="aliclik_api_token"
            label="Token de integración de Aliclik"
            set={hasToken}
            hint="Para leer el catálogo y crear guías de contraentrega desde el Master de Pedidos."
            className="max-w-xl"
          />
        </div>
        <ToggleRow
          name="aliclik_enabled"
          label="Crear guías en Aliclik"
          defaultChecked={enabled}
          on="Habilitado"
          off="Deshabilitado"
          description={
            <p>
              Crear una guía es irreversible y con ventanas de cancelación estrictas, así que hacen falta{" "}
              <strong>dos llaves</strong>: este interruptor y la variable de entorno{" "}
              <code>ALICLIK_WRITE_ENABLED=true</code> del servidor. Sin ambas, el panel cotiza pero no crea.
            </p>
          }
        />
      </StoreForm>

      <div className={cn(CARD, "divide-y divide-line")}>
        <CardHeader
          title="Webhook de estados"
          description={
            hasSecret ? (
              "Webhook con secreto propio."
            ) : (
              <span className="text-warn-fg">
                Sin secreto de webhook — genera uno antes de pegar la URL en Aliclik.
              </span>
            )
          }
          aside={
            <SubmitAction
              formAction={secretAction}
              storeId={storeId}
              pending={secretPending}
              label={hasSecret ? "Regenerar secreto" : "Generar secreto"}
              pendingLabel="Generando…"
            />
          }
        />
        <div className={cn(ROW, "space-y-3")}>
          <ActionResult state={secretState.error ? secretState : {}} />
          {revealed ? (
            <Banner tone="ok" role="status" title="Secreto generado. Cópialo ahora — no se vuelve a mostrar.">
              <CodeLine className="mt-2 bg-white">{revealed}</CodeLine>
            </Banner>
          ) : null}
          <div className="flex flex-wrap items-stretch gap-2">
            <CodeLine>{url}</CodeLine>
            <OpsButton onClick={() => copy(url)} className="h-auto min-h-9">
              <IconCopy />
              {copyLabel(copied)}
            </OpsButton>
          </div>
          <p className={HELP}>
            Pégala en «Webhook de notificaciones» del panel de Aliclik. Aliclik no firma sus avisos, así que este
            secreto es lo único que impide que un tercero inyecte cambios de estado.
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}

/**
 * Shalom · crear preguías por API.
 *
 * Dos cosas que la interfaz tiene que dejar hacer sin salir de acá, porque si no
 * hay que irse a una terminal:
 *
 *  · **Probar conexión** — comprueba la API key global y la cuenta de la tienda
 *    por separado, y lista los productos. Es la sonda del repo, en un clic. Da
 *    aviso de que TARDA: la primera vez son ~90 s de login real contra Shalom.
 *  · **Buscar agencia** — el id de la agencia de origen se configura en la
 *    cuenta y no hay otra forma de averiguarlo. Esto lo busca por texto y lo
 *    imprime.
 *
 * Las dos son de solo lectura: no crean ninguna guía. La prueba vive en la
 * sección y no en la tarjeta de la cuenta porque las dos la necesitan: la
 * sección enseña el resultado, y la cuenta saca de ahí el catálogo para el
 * desplegable de «tipo de paquete».
 */
function ShalomSection({ data }: { data: StoreSettingsData }) {
  const s = data.store;
  const has = data.has;
  const hasAccount = has.shalomProPassword && Boolean(s.shalom_pro_email);
  const [testState, testAction, testPending] = useActionState(testShalomConnection, initial);
  const [agencyState, agencyAction, agencyPending] = useActionState(findShalomAgencies, initial);
  const shalomProducts = testState.shalomProducts;

  return (
    <SettingsSection
      id="shalom"
      title="Shalom"
      badge={<Badge tone={hasAccount ? "ok" : "neutral"}>{hasAccount ? "Cuenta configurada" : "Sin cuenta"}</Badge>}
      description={
        <>
          <p>
            Permite emitir la guía de Shalom desde el Master en vez de cargarla a mano en pro.shalom.pe. No
            reemplaza la carga del reporte Excel: los envíos creados acá se cruzan con él por número de guía.
          </p>
          <p>
            «Probar conexión» puede tardar <strong>hasta 2 minutos la primera vez</strong>: Shalom hace un
            inicio de sesión real. Después la sesión queda caliente 2 horas y todo va rápido. Es solo lectura —
            no crea ninguna guía.
          </p>
        </>
      }
      actions={
        <SubmitAction
          formAction={testAction}
          storeId={s.id}
          pending={testPending}
          label="Probar conexión"
          pendingLabel="Probando… (hasta 2 min)"
        />
      }
    >
      <ActionResult state={testState} />

      <StoreForm
        storeId={s.id}
        title="Cuenta de Shalom Pro"
        description={
          <p>
            Cuenta de <strong>pro.shalom.pe</strong> con la que se emiten las guías de esta tienda. La{" "}
            <em>API key</em> del wrapper no va acá: es de la cuenta de Kapso, la misma para todas las tiendas, y
            se configura una sola vez en el servidor (<code>SHALOM_API_KEY</code>). La contraseña se guarda{" "}
            <strong>cifrada</strong>. Dos tiendas pueden compartir la misma cuenta de Shalom sin problema.
          </p>
        }
        persisted={[
          s.shalom_pro_email,
          has.shalomProPassword,
          s.shalom_origin_terminal_id,
          s.shalom_origin_terminal_name,
          s.shalom_default_product_id,
        ]}
      >
        <FieldGrid>
          <Field label="Email de Shalom Pro (pro.shalom.pe)" htmlFor="shalom_pro_email">
            <input
              id="shalom_pro_email"
              name="shalom_pro_email"
              type="email"
              defaultValue={s.shalom_pro_email ?? ""}
              className={FIELD}
            />
          </Field>
          <SecretField
            name="shalom_pro_password"
            label="Contraseña de Shalom Pro"
            set={has.shalomProPassword}
            hint="Al cambiar el email o la contraseña se descarta el token de sesión guardado y la próxima guía vuelve a pagar el login (~90 s)."
          />
          <Field
            label="Agencia de origen (ID)"
            htmlFor="shalom_origin_terminal_id"
            mark={<SavedMark set={s.shalom_origin_terminal_id != null} />}
          >
            <input
              id="shalom_origin_terminal_id"
              name="shalom_origin_terminal_id"
              inputMode="numeric"
              defaultValue={s.shalom_origin_terminal_id ?? ""}
              placeholder="404"
              className={NUMBER_FIELD}
            />
          </Field>
          <Field
            label="Agencia de origen (nombre)"
            htmlFor="shalom_origin_terminal_name"
            mark={<SavedMark set={Boolean(s.shalom_origin_terminal_name)} />}
          >
            <input
              id="shalom_origin_terminal_name"
              name="shalom_origin_terminal_name"
              defaultValue={s.shalom_origin_terminal_name ?? ""}
              placeholder="SALAS ICA"
              className={FIELD}
            />
          </Field>
          <Field
            label="Tipo de paquete por defecto"
            htmlFor="shalom_default_product_id"
            mark={<SavedMark set={s.shalom_default_product_id != null} />}
            className="sm:col-span-2"
            hint={
              shalomProducts?.length
                ? "Productos reales de esta cuenta, traídos por «Probar conexión». El modal deja cambiarlo por envío."
                : "El catálogo es por cuenta, así que el id no es universal y los de la documentación no valen. Pulsa «Probar conexión» arriba y este campo pasa a ser una lista."
            }
          >
            {/* Desplegable en cuanto «Probar conexión» haya traído el catálogo.
                No se puede cargar al abrir Ajustes: leerlo exige la sesión de
                Shalom Pro, que la primera vez son ~90 s. Sin catálogo el campo
                sigue aceptando el id a mano, que es como se configuró hasta
                ahora y como se sale del paso si la cuenta no responde. */}
            {shalomProducts?.length ? (
              <select
                id="shalom_default_product_id"
                name="shalom_default_product_id"
                defaultValue={s.shalom_default_product_id ?? ""}
                className={FIELD}
              >
                <option value="">— sin definir —</option>
                {/* El catálogo repite ids (esta cuenta manda `id=2` para «Caja
                    Paquete L» y para «Otra Medida»), así que el id no sirve de
                    clave. */}
                {shalomProducts.map((p, i) => (
                  <option key={`${p.id}-${i}`} value={p.id}>
                    {p.title}
                    {p.content ? ` — ${p.content}` : ""} (id {p.id})
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="shalom_default_product_id"
                name="shalom_default_product_id"
                inputMode="numeric"
                defaultValue={s.shalom_default_product_id ?? ""}
                placeholder="1096"
                className={cn(NUMBER_FIELD, "sm:max-w-48")}
              />
            )}
          </Field>
        </FieldGrid>
      </StoreForm>

      <div className={CARD}>
        <form action={agencyAction} className={ROW}>
          <input type="hidden" name="store_id" value={s.id} />
          <Field
            label="Buscar agencia (para conseguir el id de la de origen)"
            htmlFor="shalom_agency_q"
          >
            <div className="flex flex-wrap gap-2">
              <input
                id="shalom_agency_q"
                name="shalom_agency_q"
                placeholder="breña, arequipa, av parra…"
                className={cn(FIELD, "flex-1 basis-56")}
              />
              <OpsButton type="submit" disabled={agencyPending}>
                {agencyPending ? "Buscando…" : "Buscar"}
              </OpsButton>
            </div>
          </Field>
          <ActionResult state={agencyState} className="mt-3" />
        </form>
      </div>
    </SettingsSection>
  );
}

/**
 * Portal de clientes de Olva (0218): la cuenta con la que «Cotejar Olva» trae
 * los envíos del portal y les pone el tracking a las salidas que no lo tienen.
 */
function OlvaPortalSection({ data }: { data: StoreSettingsData }) {
  const s = data.store;
  const ready = data.has.olvaPortalPassword && Boolean(s.olva_portal_username);
  return (
    <SettingsSection
      id="olva"
      title="Olva (portal de clientes)"
      badge={<Badge tone={ready ? "ok" : "neutral"}>{ready ? "Cuenta configurada" : "Sin cuenta"}</Badge>}
      description={
        <p>
          La cuenta de <strong>atc.olvaexpress.pe</strong> con la que la empresa registra sus envíos. Con ella,{" "}
          <strong>Cotejar Olva</strong> trae los envíos del portal y les pone el tracking a las salidas que no lo
          tienen, solo cuando no hay duda. La contraseña se guarda <strong>cifrada</strong>. Si varias tiendas
          despachan con la misma cuenta, basta con ponerla en una: el cotejo mira las salidas de todas las tiendas
          de la organización.
        </p>
      }
    >
      <StoreForm
        storeId={s.id}
        persisted={[s.olva_portal_username, s.olva_portal_ruc, data.has.olvaPortalPassword]}
      >
        <FieldGrid>
          <Field
            label="Usuario del portal"
            htmlFor="olva_portal_username"
            mark={<SavedMark set={Boolean(s.olva_portal_username)} />}
          >
            <input
              id="olva_portal_username"
              name="olva_portal_username"
              autoComplete="off"
              defaultValue={s.olva_portal_username ?? ""}
              placeholder="120556792829"
              className={NUMBER_FIELD}
            />
          </Field>
          <Field label="RUC de la cuenta" htmlFor="olva_portal_ruc" mark={<SavedMark set={Boolean(s.olva_portal_ruc)} />}>
            <input
              id="olva_portal_ruc"
              name="olva_portal_ruc"
              inputMode="numeric"
              defaultValue={s.olva_portal_ruc ?? ""}
              placeholder="20556792829"
              className={NUMBER_FIELD}
            />
          </Field>
          <SecretField
            name="olva_portal_password"
            label="Contraseña del portal"
            set={data.has.olvaPortalPassword}
            className="sm:col-span-2 sm:max-w-xl"
          />
        </FieldGrid>
      </StoreForm>
    </SettingsSection>
  );
}

function TandersSection({ data }: { data: StoreSettingsData }) {
  const s = data.store;
  const ready = data.has.tandersPassword && Boolean(s.tanders_email);
  return (
    <SettingsSection
      id="tanders"
      title="Tanders (courier Lima)"
      badge={<Badge tone={ready ? "ok" : "neutral"}>{ready ? "Cuenta configurada" : "Sin cuenta"}</Badge>}
      description={
        <p>
          Cuenta de <strong>tanders.app</strong> con la que se crean las guías desde el Master de Pedidos. Tanders
          no emite API keys: se usa el mismo usuario y contraseña de su web, y la contraseña se guarda{" "}
          <strong>cifrada</strong>. El origen es el almacén desde el que sale el paquete; sus coordenadas se sacan
          del enlace de Google Maps del almacén.
        </p>
      }
    >
      <StoreForm
        storeId={s.id}
        persisted={[s.tanders_email, data.has.tandersPassword, s.tanders_origin_address, s.tanders_origin_lat, s.tanders_origin_lng]}
      >
        <FieldGrid>
          <Field label="Usuario (email)" htmlFor="tanders_email">
            <input id="tanders_email" name="tanders_email" type="email" defaultValue={s.tanders_email ?? ""} className={FIELD} />
          </Field>
          <SecretField name="tanders_password" label="Contraseña de Tanders" set={data.has.tandersPassword} />
          <Field label="Dirección del almacén de origen" htmlFor="tanders_origin_address" className="sm:col-span-2">
            <input
              id="tanders_origin_address"
              name="tanders_origin_address"
              defaultValue={s.tanders_origin_address ?? ""}
              placeholder="Jr. Restauración 525, Breña 15083, Perú"
              className={FIELD}
            />
          </Field>
          <Field label="Latitud del origen" htmlFor="tanders_origin_lat">
            <input
              id="tanders_origin_lat"
              name="tanders_origin_lat"
              defaultValue={s.tanders_origin_lat ?? ""}
              placeholder="-12.0626834"
              className={NUMBER_FIELD}
            />
          </Field>
          <Field label="Longitud del origen" htmlFor="tanders_origin_lng">
            <input
              id="tanders_origin_lng"
              name="tanders_origin_lng"
              defaultValue={s.tanders_origin_lng ?? ""}
              placeholder="-77.0510333"
              className={NUMBER_FIELD}
            />
          </Field>
        </FieldGrid>
      </StoreForm>
    </SettingsSection>
  );
}

function FlowclSection({ data }: { data: StoreSettingsData }) {
  const s = data.store;
  const has = data.has;
  const creds = [has.flowclApiKey, has.flowclSecretKey, has.flowclWebhookSecret];
  const credCount = creds.filter(Boolean).length;
  return (
    <SettingsSection
      id="flowcl"
      title="Cobro por link (Flow.cl)"
      badge={
        credCount === creds.length ? (
          <OnOff on={s.flowcl_link_enabled} onLabel="Cobro por link activo" offLabel="Cobro por link apagado" />
        ) : (
          <Badge tone={credCount ? "warn" : "neutral"}>{credCount ? "Credenciales incompletas" : "Sin credenciales"}</Badge>
        )
      }
      description={
        <p>
          Credenciales de <strong>Flow.cl</strong> de esta tienda, para cobrar el adelanto con un link de Yape One
          Shot. Son <strong>por tienda y no se comparten</strong>: la cuenta de Flow decide en qué banco cae el
          dinero, así que la de una tienda no sirve para otra de distinto titular. Sin ellas, el botón de cobro no
          aparece — no hay respaldo a una cuenta global, a propósito.
        </p>
      }
    >
      <StoreForm
        storeId={s.id}
        title="Credenciales"
        persisted={[has.flowclApiKey, has.flowclSecretKey, has.flowclWebhookSecret]}
      >
        <FieldGrid>
          <SecretField name="flowcl_api_key" label="apiKey de Flow.cl" set={has.flowclApiKey} />
          <SecretField
            name="flowcl_secret_key"
            label="secretKey de Flow.cl (firma cada cobro)"
            set={has.flowclSecretKey}
          />
          <SecretField
            name="flowcl_webhook_secret"
            label="Secreto de la url de confirmación"
            set={has.flowclWebhookSecret}
            className="sm:col-span-2"
          />
        </FieldGrid>
        <div className={ROW}>
          <p className="text-[13px] font-medium leading-5 text-ink-700">
            Url de confirmación que se le manda a Flow en cada cobro
          </p>
          <CodeLine className="mt-1.5">
            {data.siteUrl}/api/webhooks/flowcl/{s.id}?secret=&lt;el secreto de arriba&gt;
          </CodeLine>
          <p className={cn(HELP, "mt-1.5")}>
            No hay que configurarla en ningún panel: viaja en cada petición. Flow no firma sus avisos, así que el
            secreto es una puerta y no la cerradura — lo que se registra sale de volver a consultarle el estado a
            Flow, firmado.
          </p>
        </div>
      </StoreForm>

      <StoreForm
        storeId={s.id}
        title="Cobro por Flow.cl en el botón «Link de pago»"
        description={
          <p>
            Encendido, ese botón <strong>crea un cobro real por el saldo de ese momento</strong> y manda el link
            que lo cobra. El pago vuelve solo y entra <strong>ya validado</strong>: lo confirma la pasarela con su
            respuesta firmada, no la foto de una pantalla, así que el saldo baja al momento y nadie tiene que
            revisarlo. Hace falta la cuenta de Flow.cl de arriba: sin ella el botón contesta como siempre, con el
            Yape.
          </p>
        }
        persisted={[s.flowcl_link_enabled, s.flowcl_link_ttl_hours, s.flowcl_link_yape_only, s.flowcl_link_email]}
      >
        <FlowLinkFields store={s} />
      </StoreForm>
    </SettingsSection>
  );
}

/**
 * Los campos del cobro por link, con la sonda de Flow dentro.
 *
 * La sonda vive DENTRO del formulario —es donde se buscan el email y el importe
 * que prueba— pero es otra acción. Va en un botón normal que lee el formulario
 * y despacha su acción a mano, no como `formAction` de un botón de envío: el
 * primer botón de envío es el que dispara Enter, y si fuera la sonda, pulsar
 * Enter en las horas o el email crearía un cobro REAL en vez de guardar. Así,
 * además, probar no reinicia lo que se está editando en la tarjeta.
 */
function FlowLinkFields({ store: s }: { store: StoreSettingsData["store"] }) {
  const [flowProbe, flowProbeAction, flowProbePending] = useActionState(testFlowclLink, initial);
  const [, startProbe] = useTransition();
  // Controlado a propósito: la tarjeta se reinicia al guardar, y el email que
  // la sonda usa es el que está escrito, guardado o no.
  const [flowEmail, setFlowEmail] = useState(s.flowcl_link_email ?? "");
  return (
    <>
      <ToggleRow name="flowcl_link_enabled" label="Cobro por Flow" defaultChecked={s.flowcl_link_enabled} />
      <ToggleRow
        name="flowcl_link_yape_only"
        label="Medio de pago: solo Yape (One Shot)"
        description="Apagado, Flow enseña la selección con todos los medios."
        defaultChecked={s.flowcl_link_yape_only}
        on="Solo Yape"
        off="Todos"
      />
      <FieldGrid>
        <Field label="El link vence en (horas)" htmlFor="flowcl_link_ttl_hours">
          <input
            id="flowcl_link_ttl_hours"
            name="flowcl_link_ttl_hours"
            type="number"
            min={1}
            max={720}
            defaultValue={s.flowcl_link_ttl_hours ?? 48}
            className={cn(NUMBER_NARROW, "w-28")}
          />
        </Field>
        <Field
          label="Email de respaldo del cobro"
          htmlFor="flowcl_link_email"
          hint={
            <p>
              Flow exige un email del pagador y casi ningún pedido de WhatsApp trae uno. Cuando el pedido lo tiene
              se usa el suyo; si no, éste. <strong>Sin email de respaldo el cobro no se puede crear</strong> y el
              botón cae al Yape.
            </p>
          }
        >
          <input
            id="flowcl_link_email"
            name="flowcl_link_email"
            type="email"
            value={flowEmail}
            onChange={(e) => setFlowEmail(e.target.value)}
            placeholder="cobros@tutienda.com"
            className={FIELD}
          />
        </Field>
      </FieldGrid>
      <BannerRow>
        Un link vivo cobra el importe con el que nació. Si la clienta paga parte por Yape, el link viejo se deja
        de ofrecer y se crea uno nuevo por lo que falta — pero el que ya está en su chat sigue cobrando el importe
        viejo hasta que vence. Por eso las horas de arriba: cuanto más largas, más tiempo vive ese riesgo.
      </BannerRow>
      <div className={ROW}>
        <p className="text-sm font-semibold leading-5 text-ink-900">Cobro de prueba</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-sm text-ink-700" htmlFor="flowcl_probe_amount">
            Probar un cobro de S/
          </label>
          <input
            id="flowcl_probe_amount"
            name="amount"
            type="number"
            step="0.10"
            min="1"
            max="500"
            defaultValue="20"
            className={cn(NUMBER_NARROW, "w-24")}
          />
          <OpsButton
            onClick={(e) => {
              const owner = e.currentTarget.form;
              if (!owner) return;
              const data = new FormData(owner);
              startProbe(() => flowProbeAction(data));
            }}
            disabled={flowProbePending}
          >
            {flowProbePending ? "Creando…" : "Crear cobro de prueba"}
          </OpsButton>
        </div>
        <div className={cn(HELP, "mt-2 space-y-1.5")}>
          <p>
            Las <strong>credenciales</strong> tienen que estar guardadas (son secretos cifrados); el email de arriba
            vale tal como esté escrito, aunque no lo hayas guardado todavía. Crea una orden <strong>real</strong> y
            te devuelve el link: sirve para ver que la firma vale, que la url de confirmación se arma bien y que
            Flow acepta importes con céntimos. Caduca en 30 minutos.
          </p>
        </div>
        <Banner tone="warn" className="mt-3 [&_strong]:font-semibold [&_strong]:text-ink-900">
          Si la pagas, el dinero entra de verdad en tu cuenta de Flow y{" "}
          <strong>no queda colgado de ningún pedido</strong>: no hay pedido al que atarla, así que el webhook la dará
          por desconocida.
        </Banner>
        <ActionResult state={flowProbe} className="mt-3 break-all" />
      </div>
    </>
  );
}

function MetaSection({ data }: { data: StoreSettingsData }) {
  const s = data.store;
  const accounts = s.meta_ad_accounts;
  return (
    <SettingsSection
      id="meta"
      title="Meta Ads · Marketing API"
      badge={
        !data.has.metaToken ? (
          <Badge>Sin token</Badge>
        ) : accounts.length ? (
          <Badge tone="ok">
            {accounts.length === 1 ? "1 cuenta publicitaria" : `${accounts.length} cuentas publicitarias`}
          </Badge>
        ) : (
          <Badge tone="warn">Sin cuenta elegida</Badge>
        )
      }
      description={
        <p>
          Conecta la <strong>Marketing API</strong> de Meta para cruzar el <strong>gasto</strong> de tus anuncios
          con las ventas (ROAS). Pega un <strong>access token</strong> con permiso <code>ads_read</code> (ideal:
          token de un <em>system user</em>), guárdalo y luego elige la <strong>cuenta publicitaria</strong> abajo.
        </p>
      }
    >
      <StoreForm storeId={s.id} title="Token" persisted={[data.has.metaToken]}>
        <div className={ROW}>
          <SecretField
            name="meta_access_token"
            label="Access token de Meta (Marketing API)"
            set={data.has.metaToken}
            className="max-w-xl"
          />
        </div>
      </StoreForm>
      <MetaAdAccountPicker storeId={s.id} current={accounts} />
    </SettingsSection>
  );
}

function TelegramSection({ data }: { data: StoreSettingsData }) {
  const s = data.store;
  const ready = data.has.telegramToken && Boolean(s.telegram_chat_id);
  return (
    <SettingsSection
      id="telegram"
      title="Resumen diario por Telegram"
      badge={<Badge tone={ready ? "ok" : "neutral"}>{ready ? "Configurado" : "Sin configurar"}</Badge>}
      description={
        <p>
          Cada día a las <strong>8:00 am</strong> (Perú) te llega a Telegram el resumen del día anterior:{" "}
          <strong>pedidos, ingresos y rendimiento por asesor</strong>. Crea un bot con <strong>@BotFather</strong>,
          pega su token aquí y pon el <strong>chat id</strong> del chat o grupo donde quieres recibirlo. Guarda y
          usa el envío de prueba.
        </p>
      }
    >
      <StoreForm storeId={s.id} persisted={[data.has.telegramToken, s.telegram_chat_id]}>
        <FieldGrid>
          <SecretField name="telegram_bot_token" label="Token de bot de Telegram" set={data.has.telegramToken} />
          <Field
            label="Chat ID de Telegram"
            htmlFor="telegram_chat_id"
            hint={
              <p>
                Puedes poner <strong>varios</strong> chat id separados por coma para que todas las notificaciones
                lleguen a cada uno. Cada persona debe haber abierto el bot y pulsado <strong>Iniciar</strong> antes
                de poder recibir mensajes.
              </p>
            }
          >
            <input
              id="telegram_chat_id"
              name="telegram_chat_id"
              defaultValue={s.telegram_chat_id ?? ""}
              placeholder="-1001234567890, 8844863582"
              className={FIELD}
            />
          </Field>
        </FieldGrid>
      </StoreForm>
      <div className={CARD}>
        <ActionRow
          action={sendTelegramTest}
          storeId={s.id}
          title="Envío de prueba"
          label="Enviar resumen de prueba"
          help="Manda ahora mismo a tu Telegram el resumen del día anterior, para validar la configuración de arriba."
        />
      </div>

      {/* 0226: el comprobante repetido no puede esperar al resumen de mañana, y
          no tiene por qué ir al mismo chat: va al grupo de quienes deciden. */}
      <div className={cn(CARD, "space-y-3")}>
        <div>
          <p className="text-sm font-semibold text-slate-900">🚨 Alertas urgentes: comprobante repetido</p>
          <p className={HELP}>
            Cuando un mismo comprobante aparece en más de un pedido, el aviso sale al instante a este grupo con el
            bot de arriba. Crea un grupo en Telegram con las personas que deben enterarse, agrega el bot, escribe
            cualquier mensaje en el grupo y usa <strong>Buscar grupos del bot</strong> para obtener su chat id. Sin
            grupo, el aviso va al chat del resumen diario.
          </p>
        </div>
        <StoreForm storeId={s.id} persisted={[s.urgent_telegram_chat_id]}>
          <Field label="Chat ID del grupo de alertas urgentes" htmlFor="urgent_telegram_chat_id">
            <input
              id="urgent_telegram_chat_id"
              name="urgent_telegram_chat_id"
              defaultValue={s.urgent_telegram_chat_id ?? ""}
              placeholder="-1001234567890"
              className={FIELD}
            />
          </Field>
        </StoreForm>
        <ActionRow
          action={findTelegramGroups}
          storeId={s.id}
          title="Buscar grupos del bot"
          label="Buscar grupos"
          help="Lista los grupos donde está el bot y su chat id, para copiarlo arriba."
        />
        <ActionRow
          action={sendUrgentTelegramTest}
          storeId={s.id}
          title="Alerta de prueba"
          label="Enviar alerta de prueba"
          help="Manda al grupo una alerta de comprobante repetido marcada como PRUEBA."
        />
      </div>
    </SettingsSection>
  );
}

function ComprobantesSection({ data }: { data: StoreSettingsData }) {
  const s = data.store;
  return (
    <SettingsSection
      id="comprobantes"
      title="Lectura de comprobantes Yape"
      badge={<Badge tone={data.has.anthropicKey ? "ok" : "neutral"}>{data.has.anthropicKey ? "Clave propia" : "Sin clave"}</Badge>}
      description={
        <p>
          Clave de <strong>Anthropic</strong> de esta tienda. Se usa para dos cosas: decidir si una captura del
          cliente es un comprobante Yape real (la alerta de <em>Yape/Shalom por verificar</em>) y{" "}
          <strong>transcribir</strong> el comprobante en el Master de Pedidos —nº de operación, monto, fecha y
          hora— para que nadie tenga que teclearlo. Cada tienda usa <strong>su propia clave</strong>, así que el
          gasto de cada una es independiente.
        </p>
      }
    >
      <StoreForm storeId={s.id} persisted={[data.has.anthropicKey, s.anthropic_model]}>
        <FieldGrid>
          <SecretField name="anthropic_api_key" label="API key de Anthropic" set={data.has.anthropicKey} />
          <Field label="Modelo (opcional — vacío usa el valor por defecto)" htmlFor="anthropic_model">
            <input
              id="anthropic_model"
              name="anthropic_model"
              defaultValue={s.anthropic_model ?? ""}
              placeholder="claude-sonnet-5"
              className={FIELD}
            />
          </Field>
        </FieldGrid>
        <p className={cn(ROW, HELP)}>
          Sin clave, la detección se queda solo en el texto del mensaje (nunca dispara la alerta con una captura
          cualquiera) y el equipo escribe a mano el nº de operación. Recuerda que{" "}
          <strong>sin nº de operación un pago no se puede validar</strong>.
        </p>
      </StoreForm>
    </SettingsSection>
  );
}

/* ── Mensajes automáticos ────────────────────────────────────────────────── */

/** Nombre e idioma de una plantilla de Meta, en una fila. */
function TemplateFields({
  nameField,
  langField,
  name,
  lang,
  placeholder,
  nameLabel = "Nombre de la plantilla",
  langLabel = "Idioma",
}: {
  nameField: string;
  langField: string;
  name: string | null;
  lang: string | null;
  placeholder: string;
  nameLabel?: string;
  langLabel?: string;
}) {
  return (
    <>
      <Field label={nameLabel} htmlFor={nameField} className="lg:col-span-2">
        <input id={nameField} name={nameField} defaultValue={name ?? ""} placeholder={placeholder} className={FIELD} />
      </Field>
      <Field label={langLabel} htmlFor={langField}>
        <input id={langField} name={langField} defaultValue={lang ?? ""} placeholder="es" className={FIELD} />
      </Field>
    </>
  );
}

/** Un campo de número con sus límites, del ancho de su cifra. */
function NumberField({
  name,
  label,
  min,
  max,
  value,
  hint,
  className,
}: {
  name: string;
  label: string;
  min: number;
  max: number;
  value: number;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <Field label={label} htmlFor={name} hint={hint} className={className}>
      <input
        id={name}
        name={name}
        type="number"
        min={min}
        max={max}
        defaultValue={value}
        className={cn(NUMBER_NARROW, "w-28")}
      />
    </Field>
  );
}

function AutomationSections({ data }: { data: StoreSettingsData }) {
  const s = data.store;
  return (
    <>
      <SettingsSection
        id="busqueda"
        title="Búsqueda abandonada"
        badge={<OnOff on={s.browse_template_enabled} />}
        description={
          <p>
            Cuando un cliente identificado mira un producto y se va, se le envía esta plantilla de WhatsApp para
            re-engancharlo. Solo se manda a leads <strong>nuevos</strong> con nombre y producto, y requiere la
            plantilla <strong>aprobada por Meta</strong>. Si el cliente responde, el bot de Kapso toma la
            conversación.
          </p>
        }
      >
        <StoreForm storeId={s.id} persisted={[s.browse_template_enabled, s.browse_template_name, s.browse_template_language]}>
          <ToggleRow
            name="browse_template_enabled"
            label="Envío automático"
            defaultChecked={s.browse_template_enabled}
            on="Habilitado"
            off="Deshabilitado"
          />
          <FieldGrid cols={3}>
            <TemplateFields
              nameField="browse_template_name"
              langField="browse_template_language"
              name={s.browse_template_name}
              lang={s.browse_template_language}
              placeholder="busqueda_abandonada_1"
            />
          </FieldGrid>
        </StoreForm>
      </SettingsSection>

      <SettingsSection
        id="recuperacion"
        title="Recuperación de clientes (60 días sin comprar)"
        badge={<OnOff on={s.winback_template_enabled} />}
        description={
          <p>
            Un Shopify Flow avisa cuando un cliente lleva <strong>~60 días sin volver a comprar</strong> y se le
            envía esta plantilla de WhatsApp (cupón + botón a la tienda) para traerlo de vuelta. Requiere la
            plantilla <strong>aprobada por Meta</strong> y usa el mismo secreto del webhook de Flow. No crea
            leads: si el cliente responde, entra por el flujo normal de Kapso.
          </p>
        }
      >
        <StoreForm storeId={s.id} persisted={[s.winback_template_enabled, s.winback_template_name, s.winback_template_language]}>
          <ToggleRow
            name="winback_template_enabled"
            label="Envío automático"
            defaultChecked={s.winback_template_enabled}
            on="Habilitado"
            off="Deshabilitado"
          />
          <FieldGrid cols={3}>
            <TemplateFields
              nameField="winback_template_name"
              langField="winback_template_language"
              name={s.winback_template_name}
              lang={s.winback_template_language}
              placeholder="recuperacion_60d_1"
            />
          </FieldGrid>
        </StoreForm>
      </SettingsSection>

      <SettingsSection
        id="drip"
        title="Drip de seguimiento (no contesta)"
        badge={<OnOff on={s.drip_template_enabled} />}
        description={
          <p>
            A los leads en <strong>No responde / Buzón / Cuelga</strong> se les envía esta plantilla de WhatsApp
            automáticamente: <strong>máximo 2 toques</strong> (~6h después de la llamada sin respuesta y +24h el
            segundo), solo de <strong>9 am a 8 pm</strong>. Se detiene si el cliente responde o si la asesora
            agendó un seguimiento manual. Requiere la plantilla <strong>aprobada por Meta</strong> con el nombre
            del cliente como variable {"{{1}}"} (los leads sin nombre se omiten). Cada envío queda en el historial
            del lead.
          </p>
        }
      >
        <StoreForm storeId={s.id} persisted={[s.drip_template_enabled, s.drip_template_name, s.drip_template_language]}>
          <ToggleRow
            name="drip_template_enabled"
            label="Envío automático"
            defaultChecked={s.drip_template_enabled}
            on="Habilitado"
            off="Deshabilitado"
          />
          <FieldGrid cols={3}>
            <TemplateFields
              nameField="drip_template_name"
              langField="drip_template_language"
              name={s.drip_template_name}
              lang={s.drip_template_language}
              placeholder="seguimiento_nr_1"
            />
          </FieldGrid>
        </StoreForm>
      </SettingsSection>

      <SettingsSection
        id="carritos"
        title="Secuencia de carritos abandonados"
        badge={<OnOff on={s.cart_seq_enabled} />}
        description={
          <p>
            A los <strong>carritos abandonados</strong> (formulario COD de Shopify) se les envían hasta{" "}
            <strong>2 plantillas de WhatsApp</strong>, contadas desde que el cliente dejó el carrito, dentro del
            horario configurado. Corre en paralelo a la gestión de las asesoras (no cambia el estado del lead) y{" "}
            <strong>se detiene sola</strong> si el cliente compra, responde, el carrito se completa o el lead se
            marca ganado/perdido. Requiere las plantillas <strong>aprobadas por Meta</strong> con 4 variables:{" "}
            {"{{1}}"} nombre, {"{{2}}"} producto(s) x cantidad, {"{{3}}"} precio y {"{{4}}"} dirección (formato y
            textos en <code>docs/carritos-secuencia-whatsapp.md</code>). Cada envío queda en el historial del lead.
          </p>
        }
      >
        <StoreForm
          storeId={s.id}
          persisted={[
            s.cart_seq_enabled,
            s.cart_seq_hour_start,
            s.cart_seq_hour_end,
            s.cart_seq_hours_1,
            s.cart_seq_template_1_name,
            s.cart_seq_template_1_language,
            s.cart_seq_hours_2,
            s.cart_seq_template_2_name,
            s.cart_seq_template_2_language,
          ]}
        >
          <ToggleRow
            name="cart_seq_enabled"
            label="Envío automático"
            defaultChecked={s.cart_seq_enabled}
            on="Habilitado"
            off="Deshabilitado"
          />
          <div className={ROW}>
            <HourRange
              label="Horario de envío (hora local)"
              startName="cart_seq_hour_start"
              endName="cart_seq_hour_end"
              start={s.cart_seq_hour_start}
              end={s.cart_seq_hour_end}
            />
          </div>
          <SubRow title="Mensaje 1">
            <NumberField name="cart_seq_hours_1" label="Horas tras el abandono" min={1} max={168} value={s.cart_seq_hours_1} />
            <Field label="Plantilla · nombre" htmlFor="cart_seq_template_1_name">
              <input
                id="cart_seq_template_1_name"
                name="cart_seq_template_1_name"
                defaultValue={s.cart_seq_template_1_name ?? ""}
                placeholder="carrito_abandonado_1"
                className={FIELD}
              />
            </Field>
            <Field label="Plantilla · idioma" htmlFor="cart_seq_template_1_language">
              <input
                id="cart_seq_template_1_language"
                name="cart_seq_template_1_language"
                defaultValue={s.cart_seq_template_1_language ?? ""}
                placeholder="es"
                className={FIELD}
              />
            </Field>
          </SubRow>
          <SubRow title="Mensaje 2">
            <NumberField name="cart_seq_hours_2" label="Horas tras el abandono" min={1} max={336} value={s.cart_seq_hours_2} />
            <Field label="Plantilla · nombre" htmlFor="cart_seq_template_2_name">
              <input
                id="cart_seq_template_2_name"
                name="cart_seq_template_2_name"
                defaultValue={s.cart_seq_template_2_name ?? ""}
                placeholder="carrito_abandonado_2"
                className={FIELD}
              />
            </Field>
            <Field label="Plantilla · idioma" htmlFor="cart_seq_template_2_language">
              <input
                id="cart_seq_template_2_language"
                name="cart_seq_template_2_language"
                defaultValue={s.cart_seq_template_2_language ?? ""}
                placeholder="es"
                className={FIELD}
              />
            </Field>
          </SubRow>
        </StoreForm>
      </SettingsSection>

      <SettingsSection
        id="agradecer"
        title="Agradecer al entregar"
        badge={<OnOff on={s.delivered_thanks_enabled} />}
        description={
          <p>
            Cuando un pedido pasa a <strong>entregado</strong>, se le manda a la clienta una plantilla de
            agradecimiento con el botón al <strong>catálogo privado</strong>. Una vez por pedido y una por clienta
            cada 7 días, en el horario y al ritmo de abajo. Lleva una oferta, así que la plantilla va aprobada en
            Meta como <strong>Marketing</strong>.
          </p>
        }
      >
        <StoreForm
          storeId={s.id}
          persisted={[
            s.delivered_thanks_enabled,
            s.delivered_thanks_template_name,
            s.delivered_thanks_template_language,
            s.delivered_thanks_params,
            s.delivered_thanks_button_param,
            s.delivered_thanks_max_hours,
            s.delivered_thanks_hour_start,
            s.delivered_thanks_hour_end,
            s.delivered_thanks_pace_count,
            s.delivered_thanks_pace_minutes,
            s.delivered_thanks_phone_number_id,
          ]}
        >
          <ToggleRow name="delivered_thanks_enabled" label="Envío" defaultChecked={s.delivered_thanks_enabled} />
          <FieldGrid cols={3}>
            <TemplateFields
              nameField="delivered_thanks_template_name"
              langField="delivered_thanks_template_language"
              name={s.delivered_thanks_template_name}
              lang={s.delivered_thanks_template_language}
              placeholder="gracias_entrega_oferta"
              nameLabel="Plantilla · nombre"
              langLabel="Plantilla · idioma"
            />
            <Field
              label="Variables del texto"
              htmlFor="delivered_thanks_params"
              hint={
                <p>
                  Una por cada {"{{n}}"} del texto, en orden. Disponibles: <code>nombre</code>, <code>pedido</code>.
                </p>
              }
            >
              <input
                id="delivered_thanks_params"
                name="delivered_thanks_params"
                defaultValue={s.delivered_thanks_params ?? ""}
                placeholder="nombre"
                className={FIELD}
              />
            </Field>
            <Field
              label="Variables de los botones"
              htmlFor="delivered_thanks_button_param"
              className="lg:col-span-2"
              hint={
                <p>
                  Una por cada botón de URL dinámica, en orden. Con dos botones al catálogo (Kenku y Aurela) va{" "}
                  <code>telefono,telefono</code>. Disponibles: <code>telefono</code>, <code>pedido</code>. Vacío =
                  sin botones dinámicos. El celular sale en dígitos y sin «+»: en una URL el «+» se lee como espacio.
                </p>
              }
            >
              <input
                id="delivered_thanks_button_param"
                name="delivered_thanks_button_param"
                defaultValue={s.delivered_thanks_button_param ?? ""}
                placeholder="telefono"
                className={FIELD}
              />
            </Field>
          </FieldGrid>
          <SubRow title="Cuándo y a qué ritmo">
            <NumberField
              name="delivered_thanks_max_hours"
              label="No enviar si se entregó hace más de (horas)"
              min={1}
              max={720}
              value={s.delivered_thanks_max_hours}
            />
            <HourRange
              label="Horario de envío (hora local)"
              startName="delivered_thanks_hour_start"
              endName="delivered_thanks_hour_end"
              start={s.delivered_thanks_hour_start}
              end={s.delivered_thanks_hour_end}
            />
            <div className="min-w-0">
              <p className="text-[13px] font-medium leading-5 text-ink-700">Ritmo</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <input
                  aria-label="Ritmo · mensajes"
                  name="delivered_thanks_pace_count"
                  type="number"
                  min={1}
                  max={25}
                  defaultValue={s.delivered_thanks_pace_count}
                  className={cn(NUMBER_NARROW, "w-20")}
                />
                <span className="text-sm text-ink-500">cada</span>
                <input
                  aria-label="Ritmo · cada (minutos)"
                  name="delivered_thanks_pace_minutes"
                  type="number"
                  min={5}
                  max={1440}
                  defaultValue={s.delivered_thanks_pace_minutes}
                  className={cn(NUMBER_NARROW, "w-20")}
                />
                <span className="text-sm text-ink-500">min</span>
              </div>
              <p className={cn(HELP, "mt-1.5")}>
                5 cada 20 minutos = 15 por hora y hasta 180 al día de 9 a 21 h. Salen primero las entregas más
                recientes.
              </p>
            </div>
          </SubRow>
          <div className={ROW}>
            <Field label="Enviar desde otro número (opcional)" htmlFor="delivered_thanks_phone_number_id">
              <input
                id="delivered_thanks_phone_number_id"
                name="delivered_thanks_phone_number_id"
                defaultValue={s.delivered_thanks_phone_number_id ?? ""}
                placeholder="Vacío = el número de la tienda"
                className={cn(FIELD, "sm:max-w-md")}
              />
            </Field>
          </div>
        </StoreForm>
      </SettingsSection>

      <SettingsSection
        id="devueltos"
        title="Recuperar pedidos devueltos"
        badge={
          s.return_recovery_enabled ? (
            <Badge tone="ok">{s.return_recovery_auto ? "Activo · automático" : "Activo · a mano"}</Badge>
          ) : (
            <Badge>Apagado</Badge>
          )
        }
        description={
          <p>
            A la clienta cuya guía de <strong>provincia contraentrega</strong> volvió al almacén se le escribe una
            plantilla proponiéndole <strong>reenviar por agencia con adelanto</strong>. Quien{" "}
            <strong>rechazó el producto teniéndolo delante queda fuera</strong> (MOM §11). Son{" "}
            <strong>dos interruptores</strong>: el primero abre la cola y su botón, el segundo deja que el envío
            salga solo — el mensaje pide dinero por adelantado, así que conviene mirar el primer lote antes de
            soltarlo. La respuesta la atiende el bot, que es quien manda el número de cuenta.
          </p>
        }
      >
        <StoreForm
          storeId={s.id}
          persisted={[
            s.return_recovery_enabled,
            s.return_recovery_auto,
            s.return_recovery_max_days,
            s.return_recovery_template_name,
            s.return_recovery_template_language,
            s.return_recovery_params,
            s.return_recovery_hour_start,
            s.return_recovery_hour_end,
            s.return_recovery_phone_number_id,
          ]}
        >
          <ToggleRow
            name="return_recovery_enabled"
            label="Cola y botón"
            defaultChecked={s.return_recovery_enabled}
            on="Habilitado"
            off="Deshabilitado"
          />
          <ToggleRow
            name="return_recovery_auto"
            label="Envío automático"
            defaultChecked={s.return_recovery_auto}
            on="Automático"
            off="A mano"
          />
          <FieldGrid cols={3}>
            <TemplateFields
              nameField="return_recovery_template_name"
              langField="return_recovery_template_language"
              name={s.return_recovery_template_name}
              lang={s.return_recovery_template_language}
              placeholder="recuperacion_pedido_retornado"
              nameLabel="Plantilla · nombre"
              langLabel="Plantilla · idioma"
            />
            <Field
              label="Orden de las variables"
              htmlFor="return_recovery_params"
              className="sm:col-span-2 lg:col-span-3"
              hint={
                <p>
                  Uno por cada {"{{n}}"} de la plantilla, en orden. Disponibles: <code>nombre</code>,{" "}
                  <code>producto</code>, <code>monto</code>, <code>pedido</code>, <code>distrito</code>,{" "}
                  <code>agencia</code>. Tiene que coincidir con la plantilla aprobada en Meta — cada tienda tiene la
                  suya.
                </p>
              }
            >
              <input
                id="return_recovery_params"
                name="return_recovery_params"
                defaultValue={s.return_recovery_params ?? ""}
                placeholder="nombre,producto,monto"
                className={FIELD}
              />
            </Field>
            <NumberField
              name="return_recovery_max_days"
              label="No escribir si volvió hace más de (días)"
              min={1}
              max={365}
              value={s.return_recovery_max_days}
            />
            <HourRange
              label="Horario de envío (hora local)"
              startName="return_recovery_hour_start"
              endName="return_recovery_hour_end"
              start={s.return_recovery_hour_start}
              end={s.return_recovery_hour_end}
            />
          </FieldGrid>
          <div className={ROW}>
            <Field
              label="Enviar desde otro número (opcional)"
              htmlFor="return_recovery_phone_number_id"
              hint={
                <p>
                  <strong>Solo</strong> afecta a este envío: el drip y los carritos siguen saliendo del número por
                  el que escribió cada clienta, y lo demás del número de la tienda. Sirve para aislar el riesgo —
                  este mensaje pide dinero por adelantado, y un reporte le baja la calidad a toda la WABA.
                </p>
              }
            >
              <input
                id="return_recovery_phone_number_id"
                name="return_recovery_phone_number_id"
                defaultValue={s.return_recovery_phone_number_id ?? ""}
                placeholder="Vacío = el número de la tienda"
                className={cn(FIELD, "sm:max-w-md")}
              />
            </Field>
            <Banner tone="warn" title="Dos condiciones para otro número" className="mt-3 [&_strong]:font-semibold [&_strong]:text-ink-900">
              La plantilla tiene que estar <strong>aprobada en la WABA de ese número</strong> (si no, Meta responde{" "}
              <code>132001</code>), y esa línea tiene que <strong>atender la respuesta</strong> — la clienta acepta
              y alguien debe mandarle el número de cuenta. Un número que dispara y no escucha corta el circuito.
            </Banner>
          </div>
        </StoreForm>
      </SettingsSection>

      <SettingsSection
        id="agente-voz"
        title="Agente de voz · Reproprovincia"
        badge={
          s.voice_recovery_enabled ? (
            <Badge tone="ok">{s.voice_recovery_auto ? "Activo · automático" : "Activo · a mano"}</Badge>
          ) : (
            <Badge>Apagado</Badge>
          )
        }
        description={
          <p>
            Un agente de voz llama a los pedidos en <strong>gestión Reproprovincia</strong> y les propone el reenvío
            desde la bodega Swayp de su ciudad (MOM §11.8). Escribe los mismos hechos que una asesora y{" "}
            <strong>no crea guías</strong>: los «acepta» los atiende almacén. Igual que la recuperación por
            WhatsApp, son <strong>dos interruptores</strong>: el primero habilita la cola y el botón del drawer, el
            segundo deja que el barrido llame solo.
          </p>
        }
      >
        <StoreForm
          storeId={s.id}
          persisted={[
            s.voice_recovery_enabled,
            s.voice_recovery_auto,
            s.voice_recovery_can_discard,
            s.voice_recovery_agent_number,
            s.voice_recovery_zadarma_sip,
            s.voice_recovery_daily_cap,
            s.voice_recovery_max_attempts,
            s.voice_recovery_max_age_days,
            s.voice_recovery_hour_start,
            s.voice_recovery_hour_end,
          ]}
        >
          <ToggleRow
            name="voice_recovery_enabled"
            label="Cola y botón"
            defaultChecked={s.voice_recovery_enabled}
            on="Habilitado"
            off="Deshabilitado"
          />
          <ToggleRow
            name="voice_recovery_auto"
            label="Llamadas automáticas"
            defaultChecked={s.voice_recovery_auto}
            on="Automático"
            off="A mano"
          />
          <ToggleRow
            name="voice_recovery_can_discard"
            label="Quién descarta un «No lo quiere»"
            description="Apagado, el agente lo propone y lo descarta una persona."
            defaultChecked={s.voice_recovery_can_discard}
            on="El agente"
            off="Una persona"
          />
          <FieldGrid cols={3}>
            <Field label="Escenario de Zadarma del agente" htmlFor="voice_recovery_agent_number">
              <input
                id="voice_recovery_agent_number"
                name="voice_recovery_agent_number"
                defaultValue={s.voice_recovery_agent_number ?? ""}
                placeholder="Ej.: 1-11"
                className={FIELD}
              />
            </Field>
            <Field label="Extensión de Zadarma (caller ID)" htmlFor="voice_recovery_zadarma_sip">
              <input
                id="voice_recovery_zadarma_sip"
                name="voice_recovery_zadarma_sip"
                defaultValue={s.voice_recovery_zadarma_sip ?? ""}
                placeholder="Ej.: 104"
                className={FIELD}
              />
            </Field>
            <NumberField name="voice_recovery_daily_cap" label="Llamadas por día (tope)" min={0} max={500} value={s.voice_recovery_daily_cap} />
            <NumberField
              name="voice_recovery_max_attempts"
              label="Intentos del agente por pedido"
              min={1}
              max={7}
              value={s.voice_recovery_max_attempts}
            />
            <NumberField
              name="voice_recovery_max_age_days"
              label="No llamar si la guía cerró hace más de (días)"
              min={1}
              max={30}
              value={s.voice_recovery_max_age_days}
            />
            <HourRange
              label="Horario de llamadas (hora de Lima)"
              startName="voice_recovery_hour_start"
              endName="voice_recovery_hour_end"
              start={s.voice_recovery_hour_start}
              end={s.voice_recovery_hour_end}
            />
          </FieldGrid>
          <BannerRow title="Caller ID peruano">
            La extensión tiene que tener como caller ID un <strong>número peruano</strong>: sin ella Kapta no llama,
            porque la clienta vería el número de EE. UU. de la cuenta de Zadarma. Los domingos el agente no llama.
          </BannerRow>
        </StoreForm>
      </SettingsSection>

      <ShalomNoticesSection data={data} />

      <SettingsSection
        id="avisos-olva"
        title="Avisos de guía Olva (WhatsApp)"
        badge={
          <NoticeBadge transit={s.olva_transit_template_enabled} arrival={s.olva_arrival_template_enabled} />
        }
        description={
          <p>
            Los mismos dos avisos que Shalom, para las salidas de Olva con tracking registrado: uno cuando Olva la{" "}
            <strong>despacha</strong> («va en camino») y otro cuando <strong>llega a la oficina</strong> de destino
            («recógelo y paga el saldo»). Salen por el mismo número, en el mismo horario y con las mismas cuentas
            de cobro que los de Shalom; los botones los contesta Kapta igual. Lo único propio es la{" "}
            <strong>plantilla</strong>: Meta aprueba cada texto aparte, y los de Shalom nombran a Shalom. Olva
            devuelve el paquete a los <strong>6 días</strong>, no a los 28.
          </p>
        }
      >
        <StoreForm
          storeId={s.id}
          persisted={[
            s.olva_transit_template_enabled,
            s.olva_transit_template_name,
            s.olva_transit_params,
            s.olva_arrival_template_enabled,
            s.olva_arrival_template_name,
            s.olva_arrival_params,
          ]}
        >
          <ToggleRow name="olva_transit_template_enabled" label="Aviso de tránsito" defaultChecked={s.olva_transit_template_enabled} />
          <FieldGrid cols={3}>
            <Field label="Plantilla · nombre" htmlFor="olva_transit_template_name">
              <input
                id="olva_transit_template_name"
                name="olva_transit_template_name"
                defaultValue={s.olva_transit_template_name ?? ""}
                placeholder="guias_olva"
                className={FIELD}
              />
            </Field>
            <Field
              label="Orden de las variables"
              htmlFor="olva_transit_params"
              className="lg:col-span-2"
              hint={
                <p>
                  Los mismos tokens que Shalom sin <code>codigo</code>: Olva no tiene código corto. <code>guia</code>{" "}
                  es el tracking de Olva («2552504-26»), que es lo que la clienta dice en el mostrador.
                </p>
              }
            >
              <input
                id="olva_transit_params"
                name="olva_transit_params"
                defaultValue={s.olva_transit_params ?? ""}
                placeholder="nombre,guia,producto,agencia,total,adelanto,saldo,yape"
                className={FIELD}
              />
            </Field>
          </FieldGrid>
          <ToggleRow name="olva_arrival_template_enabled" label="Aviso de llegada" defaultChecked={s.olva_arrival_template_enabled} />
          <FieldGrid cols={3}>
            <Field label="Plantilla · nombre" htmlFor="olva_arrival_template_name">
              <input
                id="olva_arrival_template_name"
                name="olva_arrival_template_name"
                defaultValue={s.olva_arrival_template_name ?? ""}
                placeholder="guias_olva_llegada"
                className={FIELD}
              />
            </Field>
            <Field
              label="Orden de las variables"
              htmlFor="olva_arrival_params"
              className="lg:col-span-2"
              hint={
                <p>
                  <code>agencia</code> es la oficina de Olva que el rastreo apuntó al llegar. Si se usa{" "}
                  <code>vence</code>, se calcula a 6 días.
                </p>
              }
            >
              <input
                id="olva_arrival_params"
                name="olva_arrival_params"
                defaultValue={s.olva_arrival_params ?? ""}
                placeholder="nombre,guia,producto,agencia,total,adelanto,saldo"
                className={FIELD}
              />
            </Field>
          </FieldGrid>
          <BannerRow>
            Las dos plantillas tienen que estar <strong>aprobadas en Meta</strong> con ese nombre y ese número de
            variables, en la WABA del número por el que salen. Hasta entonces, deja el aviso apagado: la cola cierra
            las filas como «omitidas» y no se pierde nada.
          </BannerRow>
        </StoreForm>
      </SettingsSection>
    </>
  );
}

/** La chapa de un par de avisos (tránsito y llegada). */
function NoticeBadge({ transit, arrival }: { transit: boolean; arrival: boolean }) {
  if (transit && arrival) return <Badge tone="ok">Tránsito y llegada activos</Badge>;
  if (transit) return <Badge tone="ok">Tránsito activo</Badge>;
  if (arrival) return <Badge tone="ok">Llegada activa</Badge>;
  return <Badge>Apagados</Badge>;
}

function ShalomNoticesSection({ data }: { data: StoreSettingsData }) {
  const s = data.store;
  return (
    <SettingsSection
      id="avisos-shalom"
      title="Avisos de guía Shalom (WhatsApp)"
      badge={<NoticeBadge transit={s.shalom_transit_template_enabled} arrival={s.shalom_arrival_template_enabled} />}
      description={
        <p>
          Cuando Shalom mueve una guía a <strong>en tránsito</strong>, se le manda a la clienta la plantilla
          aprobada con la guía, el código, la agencia, el producto y el resumen de pago (total, adelanto validado y
          saldo). Los tres botones —Yape, transferencia y link— los contesta Kapta sola con las{" "}
          <SectionLink to="cuentas">cuentas de cobro</SectionLink>. Sale <strong>una sola vez por guía</strong>,
          dentro del horario, y nunca lleva la clave de recojo: esa se entrega con el cobro validado, desde la
          salida.
        </p>
      }
    >
      <StoreForm
        storeId={s.id}
        title="Va en camino"
        persisted={[
          s.shalom_transit_template_enabled,
          s.shalom_transit_template_name,
          s.shalom_transit_template_language,
          s.shalom_transit_params,
          s.shalom_transit_attach_ticket,
          s.shalom_transit_hour_start,
          s.shalom_transit_hour_end,
          s.shalom_notice_daily_cap,
          s.shalom_notice_hourly_cap,
          s.shalom_transit_phone_number_id,
          s.shalom_transit_payment_link,
        ]}
      >
        <ToggleRow name="shalom_transit_template_enabled" label="Aviso de tránsito" defaultChecked={s.shalom_transit_template_enabled} />
        <FieldGrid cols={3}>
          <TemplateFields
            nameField="shalom_transit_template_name"
            langField="shalom_transit_template_language"
            name={s.shalom_transit_template_name}
            lang={s.shalom_transit_template_language}
            placeholder="guias_shalom"
            nameLabel="Plantilla · nombre"
            langLabel="Plantilla · idioma"
          />
          <Field
            label="Orden de las variables"
            htmlFor="shalom_transit_params"
            className="sm:col-span-2 lg:col-span-3"
            hint={
              <p>
                Uno por cada {"{{n}}"} de la plantilla, en orden. Disponibles: <code>nombre</code>, <code>guia</code>,{" "}
                <code>codigo</code>, <code>producto</code>, <code>agencia</code>, <code>total</code>,{" "}
                <code>adelanto</code>, <code>saldo</code>, <code>yape</code>. El de <code>guias_shalom</code> es el
                que sale de ejemplo.
              </p>
            }
          >
            <input
              id="shalom_transit_params"
              name="shalom_transit_params"
              defaultValue={s.shalom_transit_params ?? ""}
              placeholder="nombre,guia,codigo,producto,agencia,total,adelanto,saldo,yape"
              className={FIELD}
            />
          </Field>
        </FieldGrid>
        <BannerRow title="Importes sin «S/»">
          Los importes van <strong>sin «S/»</strong> —«89.10»— porque la plantilla ya lo escribe (
          <code>Monto total del pedido: S/ {"{{6}}"}</code>). Y si la plantilla trae el Yape fijo en el cuerpo en
          vez de como variable, quita <code>yape</code> de la lista: sobra un parámetro y Meta rechaza el envío.
        </BannerRow>
        <ToggleRow
          name="shalom_transit_attach_ticket"
          label="Ticket de Shalom en cabecera"
          description={
            <p>
              Solo con una plantilla aprobada con cabecera de documento (<code>guias_shalom_imagen</code>). Con la
              plantilla de texto, déjalo en No o Meta la rechaza.
            </p>
          }
          defaultChecked={s.shalom_transit_attach_ticket}
          on="Sí"
          off="No"
        />
        <SubRow
          title="Horario y topes"
          description={
            <p>
              Los topes cuentan los avisos de Shalom y Olva, tránsito y llegada juntos. El diario es en 24 h
              móviles, como lo mide WhatsApp. Al llegar al tope el aviso <strong>espera en la cola</strong> y sale
              en la siguiente pasada con cupo: no se pierde. Un número nuevo tiene que empezar bajo y subir a medida
              que gana calidad. No cuenta las respuestas a lo que escribe la clienta.
            </p>
          }
        >
          <HourRange
            label="Horario de envío (hora local)"
            startName="shalom_transit_hour_start"
            endName="shalom_transit_hour_end"
            start={s.shalom_transit_hour_start}
            end={s.shalom_transit_hour_end}
          />
          <NumberField name="shalom_notice_daily_cap" label="Máximo por día" min={0} max={1000} value={s.shalom_notice_daily_cap} />
          <NumberField name="shalom_notice_hourly_cap" label="Máximo por hora" min={0} max={1000} value={s.shalom_notice_hourly_cap} />
        </SubRow>
        <div className={cn(ROW, "space-y-5")}>
          <Field label="Enviar desde otro número (opcional)" htmlFor="shalom_transit_phone_number_id">
            <input
              id="shalom_transit_phone_number_id"
              name="shalom_transit_phone_number_id"
              defaultValue={s.shalom_transit_phone_number_id ?? ""}
              placeholder="Vacío = el número por el que escribió la clienta, o el de la tienda"
              className={cn(FIELD, "sm:max-w-xl")}
            />
          </Field>
          <Field
            label="Respuesta al botón «Link de pago»"
            htmlFor="shalom_transit_payment_link"
            hint={
              <p>
                Texto libre; se sustituyen <code>{"{saldo}"}</code>, <code>{"{pedido}"}</code>,{" "}
                <code>{"{yape}"}</code> y <code>{"{link}"}</code> (el cobro de Flow, que se configura en{" "}
                <SectionLink to="flowcl">Cobro por link (Flow.cl)</SectionLink>). Vacío = el link de Flow si lo hay,
                y si no el Yape principal.
              </p>
            }
          >
            <textarea
              id="shalom_transit_payment_link"
              name="shalom_transit_payment_link"
              rows={3}
              defaultValue={s.shalom_transit_payment_link ?? ""}
              placeholder={"Paga tu saldo de {saldo} del pedido {pedido} aquí: https://…"}
              className={TEXTAREA}
            />
          </Field>
        </div>
      </StoreForm>

      <StoreForm
        storeId={s.id}
        title="Ya llegó a tu agencia"
        description={
          <p>
            El de arriba sale cuando el paquete <strong>va en camino</strong> y dice que llegará en 2 a 5 días. Éste
            sale cuando <strong>ya llegó</strong> y le dice hasta qué día puede recogerlo — 28 días desde que llegó,
            y después Shalom lo devuelve. Es otra plantilla aprobada aparte, con su propio interruptor; el número, el
            horario y las cuentas son los mismos de arriba.
          </p>
        }
        persisted={[
          s.shalom_arrival_template_enabled,
          s.shalom_arrival_template_name,
          s.shalom_arrival_attach_ticket,
          s.shalom_voucher_intake_enabled,
          s.shalom_pickup_key_autosend_enabled,
          s.shalom_arrival_params,
        ]}
      >
        <ToggleRow name="shalom_arrival_template_enabled" label="Aviso de llegada" defaultChecked={s.shalom_arrival_template_enabled} />
        <FieldGrid cols={3}>
          <Field label="Plantilla · nombre" htmlFor="shalom_arrival_template_name">
            <input
              id="shalom_arrival_template_name"
              name="shalom_arrival_template_name"
              defaultValue={s.shalom_arrival_template_name ?? ""}
              placeholder="guias_shalom_llegada"
              className={FIELD}
            />
          </Field>
          <Field
            label="Orden de las variables"
            htmlFor="shalom_arrival_params"
            className="lg:col-span-2"
            hint={
              <p>
                Las mismas de arriba más <code>vence</code>, la fecha límite de recojo. Sin fecha de llegada
                registrada no se inventa un plazo: el aviso se reintenta y queda escrito que faltaba{" "}
                <code>vence</code>.
              </p>
            }
          >
            <input
              id="shalom_arrival_params"
              name="shalom_arrival_params"
              defaultValue={s.shalom_arrival_params ?? ""}
              placeholder="nombre,guia,codigo,producto,agencia,total,adelanto,saldo,vence"
              className={FIELD}
            />
          </Field>
        </FieldGrid>
        <ToggleRow
          name="shalom_arrival_attach_ticket"
          label="Ticket en cabecera"
          defaultChecked={s.shalom_arrival_attach_ticket}
          on="Sí"
          off="No"
        />
        <ToggleRow
          name="shalom_voucher_intake_enabled"
          label="Registrar solos los comprobantes que lleguen por WhatsApp"
          defaultChecked={s.shalom_voucher_intake_enabled}
          description={
            <p>
              Cuando la clienta contesta el aviso con la captura de su Yape, se lee sola y entra a{" "}
              <strong>Revisión de pagos</strong> colgada de su pedido, sin validar. Solo pasa si el{" "}
              <strong>monto coincide exacto</strong> con el saldo o el total, o si escribió la <strong>guía</strong>.
              Lo demás queda como anomalía con su motivo, para subirlo a mano.
            </p>
          }
        >
          <Banner tone="warn" className="[&_strong]:font-semibold [&_strong]:text-ink-900">
            Escribe filas de dinero <strong>sin que una persona mire la imagen</strong>. Entran sin validar, así que
            un error puede ensuciar la cola de revisión — no soltar un paquete sin cobrar, que sigue necesitando
            validación humana.
          </Banner>
        </ToggleRow>
        <ToggleRow
          name="shalom_pickup_key_autosend_enabled"
          label="Enviar la clave de recojo al validar el pago"
          defaultChecked={s.shalom_pickup_key_autosend_enabled}
          description={
            <p>
              En el comprobante que <strong>termina de cubrir el pedido</strong>, el botón pasa a decir «Validar y
              enviar la clave» y enseña el mensaje exacto antes de pulsarlo. El envío <strong>es</strong> el
              registro de la entrega: ya no hace falta anotarla aparte. Fuera de las 24 h desde el último mensaje de
              la clienta no se manda nada —WhatsApp no lo permite— y se avisa en pantalla.
            </p>
          }
        >
          <Banner tone="warn" className="[&_strong]:font-semibold [&_strong]:text-ink-900">
            Manda <strong>la llave del paquete</strong> sin que nadie vuelva a mirar después del clic. Las
            condiciones de siempre se comprueban otra vez en el servidor antes de descifrarla; validar desde la
            bandeja de revisión no envía nada.
          </Banner>
        </ToggleRow>
      </StoreForm>

      <div className={CARD}>
        <ActionRow
          action={sendTransitQueueNow}
          storeId={s.id}
          title="Cola de avisos"
          label="Enviar ahora los avisos en cola"
          pendingLabel="Enviando…"
          help="El cron drena la cola cada 30 minutos; esto lo hace ya. No fuerza nada: manda lo que está pendiente y le toca. Sigue respetando el horario, los reintentos y los interruptores de arriba."
        />
      </div>
    </SettingsSection>
  );
}

/* ── Listas: plantillas, cuentas, escalera, cobertura ────────────────────── */

/** Lo que dijo la última acción sobre una fila de la lista. */
function RowMessage({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <p role="status" className={cn(ROW, "py-3 text-[13px] text-ink-600")}>
      {msg}
    </p>
  );
}

/** Pie de un formulario de alta: el botón y lo que respondió. */
function AddFooter({ pending, label, pendingLabel, state }: { pending: boolean; label: string; pendingLabel: string; state: SettingsState }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <OpsButton type="submit" variant="primary" disabled={pending}>
        {pending ? pendingLabel : label}
      </OpsButton>
      <p role="status" className="min-w-0 text-[13px]">
        {state.error ? (
          <span className="text-crit-fg">{state.error}</span>
        ) : state.notice ? (
          <span className="text-ok-fg">{state.notice}</span>
        ) : null}
      </p>
    </div>
  );
}

/**
 * El catálogo de plantillas que el asesor puede mandar desde el drawer cuando la
 * ventana de 24 h ya se cerró.
 *
 * Va en su propia tarjeta, fuera de las de la tienda, porque son filas —se
 * agregan y se retiran de a una, no se «guardan» todas juntas—.
 *
 * Se configura acá y no en el drawer, al revés que las respuestas rápidas,
 * porque el nombre tiene que coincidir EXACTO con lo aprobado en Meta: escribirlo
 * mal no rompe un chat, le baja la calidad a la WABA de toda la tienda.
 */
function ReplyTemplatesSection({
  storeId,
  rows,
}: {
  storeId: string;
  rows: StoreSettingsData["replyTemplates"];
}) {
  const [state, formAction, pending] = useActionState(addReplyTemplate, initial);
  const [rowPending, startRowTransition] = useTransition();
  const [rowMsg, setRowMsg] = useState<string | null>(null);
  const activeCount = rows.filter((t) => t.active).length;

  function toggle(id: string, active: boolean) {
    startRowTransition(async () => {
      const res = await setReplyTemplateActive(storeId, id, active);
      setRowMsg(res.error ?? res.notice ?? null);
    });
  }
  function remove(id: string, label: string) {
    if (!confirm(`¿Eliminar la plantilla «${label}»?`)) return;
    startRowTransition(async () => {
      const res = await deleteReplyTemplate(storeId, id);
      setRowMsg(res.error ?? res.notice ?? null);
    });
  }

  return (
    <SettingsSection
      id="plantillas"
      title="Plantillas de respuesta"
      badge={<Badge tone={activeCount ? "ok" : "neutral"}>{activeCount === 1 ? "1 activa" : `${activeCount} activas`}</Badge>}
      description={
        <>
          <p>Lo único que se puede enviar cuando la ventana de 24h del cliente ya se cerró.</p>
          <p>
            Fuera de las 24h desde el último mensaje del cliente, WhatsApp no deja mandar texto libre. Lo que se
            cargue acá es lo que el asesor verá en el chat para poder responder igual. El nombre y el idioma tienen
            que ser los <strong>aprobados en Meta</strong>: cada tienda es una WABA distinta, así que no se pueden
            compartir entre tiendas.
          </p>
        </>
      }
    >
      <div className={cn(CARD, "divide-y divide-line")}>
        {rows.length > 0 ? (
          <RowList>
            {rows.map((t) => (
              <li key={t.id} className={cn(ROW, "flex flex-wrap items-start gap-x-4 gap-y-3")}>
                <div className="min-w-0 flex-1 basis-64">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold leading-5 text-ink-900">
                    {t.label}
                    {!t.active && <Badge>Retirada</Badge>}
                  </p>
                  <p className="mt-0.5 text-[13px] leading-5 text-ink-500">
                    <code>{t.template_name}</code> · {t.language}
                    {t.params ? ` · ${t.params}` : " · sin variables"}
                  </p>
                  {t.body_preview && (
                    <p className="mt-2 whitespace-pre-wrap rounded-md bg-wash px-3 py-2 text-[13px] leading-5 text-ink-700">
                      {t.body_preview}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <OpsButton size="sm" onClick={() => toggle(t.id, !t.active)} disabled={rowPending}>
                    {t.active ? "Retirar" : "Activar"}
                  </OpsButton>
                  <OpsButton size="sm" variant="danger" onClick={() => remove(t.id, t.label)} disabled={rowPending}>
                    Eliminar
                  </OpsButton>
                </div>
              </li>
            ))}
          </RowList>
        ) : (
          <EmptyRow>
            Aún no hay plantillas: con la ventana de 24h cerrada, el asesor no tiene nada que mandar. Agrega la
            primera abajo.
          </EmptyRow>
        )}
        <RowMessage msg={rowMsg} />

        <form action={formAction} className={cn(ROW, "space-y-5")}>
          <input type="hidden" name="store_id" value={storeId} />
          <p className="text-sm font-semibold leading-5 text-ink-900">Agregar plantilla</p>
          <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Nombre visible" htmlFor="rt_label" hint="Lo que lee el asesor en el desplegable.">
              <input id="rt_label" name="label" placeholder="Retomar pedido" className={FIELD} />
            </Field>
            <Field label="Nombre en Meta" htmlFor="rt_template_name" hint="Minúsculas, números y guion bajo.">
              <input id="rt_template_name" name="template_name" placeholder="retomar_pedido_v1" className={FIELD} />
            </Field>
            <Field label="Idioma" htmlFor="rt_language">
              <input id="rt_language" name="language" placeholder="es" className={FIELD} />
            </Field>
          </div>
          <Field
            label="Orden de las variables"
            htmlFor="rt_params"
            hint={
              <p>
                Uno por cada {"{{n}}"} de la plantilla, en orden. Disponibles: <code>nombre</code>,{" "}
                <code>producto</code>, <code>monto</code>, <code>distrito</code>, <code>tienda</code>. Se pre-rellenan
                con los datos del lead y el asesor puede corregirlos antes de enviar. Déjalo vacío si la plantilla no
                lleva variables.
              </p>
            }
          >
            <input id="rt_params" name="params" placeholder="nombre,producto" className={FIELD} />
          </Field>
          <Field
            label="Cuerpo aprobado (opcional)"
            htmlFor="rt_body_preview"
            hint={
              <p>
                Cópialo tal cual de Meta, con los {"{{n}}"} sin reemplazar. No se envía: sirve para que el asesor lea
                lo que va a mandar en vez de elegir a ciegas por el nombre.
              </p>
            }
          >
            <textarea
              id="rt_body_preview"
              name="body_preview"
              rows={3}
              placeholder="Hola {{1}}, tu {{2}} sigue disponible…"
              className={TEXTAREA}
            />
          </Field>
          <AddFooter pending={pending} label="Agregar plantilla" pendingLabel="Agregando…" state={state} />
        </form>
      </div>
    </SettingsSection>
  );
}

const KIND_LABEL: Record<string, string> = {
  yape: "Yape",
  plin: "Plin",
  banco: "Banco",
  billetera: "Billetera",
};

/**
 * Cuentas de cobro que se le ENSEÑAN al cliente: lo que contestan los botones
 * del aviso de guía en tránsito. Lista por tienda, como las plantillas de
 * respuesta. No son las cuentas contra las que se VERIFICA un comprobante.
 */
function PaymentMethodsSection({
  storeId,
  rows,
}: {
  storeId: string;
  rows: StoreSettingsData["paymentMethods"];
}) {
  const [state, formAction, pending] = useActionState(addPaymentMethod, initial);
  const [rowPending, startRowTransition] = useTransition();
  const [rowMsg, setRowMsg] = useState<string | null>(null);
  const hasPrimary = rows.some((m) => m.primary_yape && m.active);

  function run(fn: () => Promise<SettingsState>) {
    startRowTransition(async () => {
      const res = await fn();
      setRowMsg(res.error ?? res.notice ?? null);
    });
  }

  return (
    <SettingsSection
      id="cuentas"
      title="Cuentas de cobro que ve el cliente"
      badge={rows.length > 0 && !hasPrimary ? <Badge tone="warn">Sin Yape principal</Badge> : undefined}
      description={
        <>
          <p>
            Lo que Kapta contesta cuando la clienta pulsa «Pagar con Yape» o «Transferencia Depósito» en el{" "}
            <SectionLink to="avisos-shalom">aviso de guía en tránsito</SectionLink>.
          </p>
          <p>
            El <strong>Yape principal</strong> contesta al botón de Yape y rellena la variable <code>yape</code> de
            la plantilla; la transferencia lista <strong>todas</strong> las cuentas activas, en este orden. No
            confundir con las cuentas contra las que se verifica un comprobante: conviene que el Yape principal sea
            una de ellas, o el pago quedará en revisión.
          </p>
        </>
      }
    >
      <div className={cn(CARD, "divide-y divide-line")}>
        {rows.length > 0 ? (
          <RowList>
            {rows.map((m) => (
              <li key={m.id} className={cn(ROW, "flex flex-wrap items-start gap-x-4 gap-y-3")}>
                <div className="min-w-0 flex-1 basis-64">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold leading-5 text-ink-900">
                    {m.label}
                    <Badge>{KIND_LABEL[m.kind] ?? m.kind}</Badge>
                    {m.primary_yape && <Badge tone="ok">Yape principal</Badge>}
                    {!m.active && <Badge>Retirada</Badge>}
                  </p>
                  <p className="mt-0.5 text-[13px] leading-5 text-ink-500">
                    A nombre de {m.holder}
                    {m.detail ? ` · ${m.detail}` : ""} · <code className="tabular-nums">{m.account}</code>
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {m.kind === "yape" && m.active && !m.primary_yape && (
                    <OpsButton size="sm" onClick={() => run(() => setPrimaryYape(storeId, m.id))} disabled={rowPending}>
                      Hacer principal
                    </OpsButton>
                  )}
                  <OpsButton
                    size="sm"
                    onClick={() => run(() => setPaymentMethodActive(storeId, m.id, !m.active))}
                    disabled={rowPending}
                  >
                    {m.active ? "Retirar" : "Activar"}
                  </OpsButton>
                  <OpsButton
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      if (!confirm(`¿Eliminar la cuenta «${m.label}»?`)) return;
                      run(() => deletePaymentMethod(storeId, m.id));
                    }}
                    disabled={rowPending}
                  >
                    Eliminar
                  </OpsButton>
                </div>
              </li>
            ))}
          </RowList>
        ) : (
          <EmptyRow>
            Aún no hay cuentas: sin ellas, los botones de pago del aviso no tienen qué contestar. Agrega la primera
            abajo.
          </EmptyRow>
        )}
        <RowMessage msg={rowMsg} />

        <form action={formAction} className={cn(ROW, "space-y-5")}>
          <input type="hidden" name="store_id" value={storeId} />
          <p className="text-sm font-semibold leading-5 text-ink-900">Agregar cuenta</p>
          <div className="grid gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Tipo" htmlFor="pm_kind">
              <select id="pm_kind" name="kind" defaultValue="banco" className={FIELD}>
                <option value="banco">Banco</option>
                <option value="yape">Yape</option>
                <option value="plin">Plin</option>
                <option value="billetera">Billetera (Lukita, Agora…)</option>
              </select>
            </Field>
            <Field label="Nombre" htmlFor="pm_label">
              <input id="pm_label" name="label" placeholder="BCP, YAPE 1, INTERBANK…" className={FIELD} />
            </Field>
            <Field label="A nombre de" htmlFor="pm_holder">
              <input id="pm_holder" name="holder" placeholder="Grupo GF SAC" className={FIELD} />
            </Field>
            <Field label="Número" htmlFor="pm_account">
              <input id="pm_account" name="account" placeholder="191-2434540-0-12 o 930555309" className={NUMBER_FIELD} />
            </Field>
            <Field label="Detalle (opcional)" htmlFor="pm_detail">
              <input id="pm_detail" name="detail" placeholder="CUENTA CORRIENTE BCP SOLES" className={FIELD} />
            </Field>
            <Field label="Yape principal" htmlFor="pm_primary">
              <select id="pm_primary" name="primary_yape" defaultValue="false" className={FIELD}>
                <option value="false">No</option>
                <option value="true">Sí (solo tipo Yape)</option>
              </select>
            </Field>
          </div>
          <AddFooter pending={pending} label="Agregar cuenta" pendingLabel="Guardando…" state={state} />
        </form>
      </div>
    </SettingsSection>
  );
}

/** La escalera de la cola de cobranza (0172): a quién sube una alerta y cuándo. */
function EscalationSection({
  storeId,
  rows,
  candidates,
}: {
  storeId: string;
  rows: StoreSettingsData["escalation"];
  candidates: StoreSettingsData["escalationCandidates"];
}) {
  const [state, formAction, pending] = useActionState(addEscalationStep, initial);
  const [rowPending, startRowTransition] = useTransition();
  const [rowMsg, setRowMsg] = useState<string | null>(null);

  function run(fn: () => Promise<SettingsState>) {
    startRowTransition(async () => {
      const res = await fn();
      setRowMsg(res.error ?? res.notice ?? null);
    });
  }

  const libres = candidates.filter((c) => !rows.some((r) => r.userId === c.id));

  return (
    <SettingsSection
      id="escalera"
      title="Quién atiende la cobranza del número de Shalom"
      badge={rows.length === 0 ? <Badge tone="warn">Nadie configurado</Badge> : undefined}
      description={
        <p>
          Cuando llega un comprobante por WhatsApp, la alerta se le ofrece al primero de la lista. Si no la atiende
          en sus minutos, sube al siguiente.
        </p>
      }
    >
      <div className={cn(CARD, "divide-y divide-line")}>
        {rows.length === 0 ? (
          <BannerRow>
            Nadie configurado todavía. Las alertas se crean igual y se ven en la cola de la tienda, pero{" "}
            <strong>no le llegan a nadie</strong>.
          </BannerRow>
        ) : (
          <ol className="divide-y divide-line">
            {rows.map((r, i) => (
              <li key={r.id} className={cn(ROW, "flex flex-wrap items-center gap-x-3 gap-y-2 py-3")}>
                <span
                  aria-hidden
                  className="grid size-6 shrink-0 place-items-center rounded-full bg-wash text-xs font-semibold tabular-nums text-ink-700 ring-1 ring-inset ring-line"
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-5 text-ink-900">{r.name}</p>
                  <p className="text-[13px] leading-5 text-ink-500">
                    {i === rows.length - 1 ? "Es el último: aquí se queda" : `Escala a los ${r.minutes} min`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <OpsButton
                    size="sm"
                    aria-label={`Subir a ${r.name}`}
                    title="Subir"
                    disabled={rowPending || i === 0}
                    onClick={() => run(() => moveEscalationStep(storeId, r.id, "up"))}
                    className="w-8 px-0 pointer-coarse:w-11"
                  >
                    <IconChevronDown className="rotate-180" />
                  </OpsButton>
                  <OpsButton
                    size="sm"
                    aria-label={`Bajar a ${r.name}`}
                    title="Bajar"
                    disabled={rowPending || i === rows.length - 1}
                    onClick={() => run(() => moveEscalationStep(storeId, r.id, "down"))}
                    className="w-8 px-0 pointer-coarse:w-11"
                  >
                    <IconChevronDown />
                  </OpsButton>
                  <OpsButton
                    size="sm"
                    variant="danger"
                    disabled={rowPending}
                    onClick={() => run(() => removeEscalationStep(storeId, r.id))}
                  >
                    Quitar
                  </OpsButton>
                </div>
              </li>
            ))}
          </ol>
        )}
        <RowMessage msg={rowMsg} />

        <form action={formAction} className={ROW}>
          <input type="hidden" name="store_id" value={storeId} />
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Añadir a" htmlFor="escalation_user" className="flex-1 basis-48">
              <select id="escalation_user" name="user_id" className={FIELD} defaultValue="">
                <option value="">Elige…</option>
                {libres.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Escala a los (min)" htmlFor="escalation_minutes">
              <input
                id="escalation_minutes"
                name="minutes"
                type="number"
                min={1}
                max={1440}
                defaultValue={30}
                className={cn(NUMBER_NARROW, "w-28")}
              />
            </Field>
            <OpsButton type="submit" disabled={pending || libres.length === 0}>
              {pending ? "Añadiendo…" : "Añadir"}
            </OpsButton>
          </div>
          <p role="status" className="mt-2 text-[13px] empty:hidden">
            {state.error ? (
              <span className="text-crit-fg">{state.error}</span>
            ) : state.notice ? (
              <span className="text-ok-fg">{state.notice}</span>
            ) : null}
          </p>
          <p className={cn(HELP, "mt-3")}>
            La espera <strong>no mira si está conectado</strong>: aguanta sus minutos aunque tenga el navegador
            cerrado. Si saltara al desconectarse, todo acabaría siempre en el último.
          </p>
        </form>
      </div>
    </SettingsSection>
  );
}

const COVERAGE_LABEL: Record<string, string> = {
  lima: "Lima",
  provincia_cod: "Provincia COD",
  agencia: "Agencia",
};

/**
 * Excepciones de cobertura por distrito (0121).
 *
 * La lista está VACÍA casi siempre, y eso es lo correcto: solo guarda lo que se
 * aparta de la regla general. Por eso el texto explica primero qué decide la
 * regla y luego para qué sirve apartarse — sin eso, una tabla vacía se lee como
 * «falta configurar algo».
 */
function DistrictCoverageSection({
  storeId,
  rows,
}: {
  storeId: string;
  rows: StoreSettingsData["districtCoverage"];
}) {
  const [state, formAction, pending] = useActionState(saveDistrictCoverage, initial);
  const [rowPending, startRowTransition] = useTransition();
  const [rowMsg, setRowMsg] = useState<string | null>(null);

  function remove(id: string, district: string) {
    if (!confirm(`¿Quitar la excepción de «${district}»? Vuelve a la regla general.`)) return;
    startRowTransition(async () => {
      const res = await deleteDistrictCoverage(storeId, id);
      setRowMsg(res.error ?? res.notice ?? null);
    });
  }

  return (
    <SettingsSection
      id="cobertura"
      title="Cobertura por distrito"
      badge={rows.length > 0 ? <Badge>{rows.length === 1 ? "1 excepción" : `${rows.length} excepciones`}</Badge> : undefined}
      description={
        <>
          <p>Dónde la operación se aparta de lo que dice la geografía.</p>
          <p>
            Por defecto la cobertura la decide la regla general: Lima Metropolitana y Callao son <strong>Lima</strong>,
            un destino con tarifa COD vigente es <strong>Provincia COD</strong>, y el resto <strong>Agencia</strong>.
            Acá solo se anota lo que se aparta de eso — por ejemplo Pucusana, que el ubigeo pone en la provincia de
            Lima pero al que el reparto propio no llega. Lo que se escriba acá{" "}
            <strong>gana sobre cualquier regla automática</strong>.
          </p>
          <p>
            Al guardar se reclasifican también los pedidos <strong>abiertos</strong> de ese distrito, no solo los
            nuevos. Los ya finalizados no se tocan: su historia queda como ocurrió.
          </p>
        </>
      }
    >
      <div className={cn(CARD, "divide-y divide-line")}>
        {rows.length > 0 ? (
          <RowList>
            {rows.map((r) => (
              <li key={r.id} className={cn(ROW, "flex flex-wrap items-start gap-x-4 gap-y-2 py-3")}>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold capitalize leading-5 text-ink-900">
                    {r.district}
                    <Badge className="normal-case">{COVERAGE_LABEL[r.coverage] ?? r.coverage}</Badge>
                    {r.store_id === null && <Badge className="normal-case">Todas las tiendas</Badge>}
                  </p>
                  {r.note && <p className="mt-0.5 text-[13px] leading-5 text-ink-500">{r.note}</p>}
                </div>
                <OpsButton size="sm" variant="danger" disabled={rowPending} onClick={() => remove(r.id, r.district)}>
                  Quitar
                </OpsButton>
              </li>
            ))}
          </RowList>
        ) : (
          <EmptyRow>Sin excepciones: manda la regla general en todos los distritos.</EmptyRow>
        )}
        <RowMessage msg={rowMsg} />

        <form action={formAction} className={cn(ROW, "space-y-5")}>
          <input type="hidden" name="store_id" value={storeId} />
          <p className="text-sm font-semibold leading-5 text-ink-900">Agregar excepción</p>
          <div className="grid gap-x-4 gap-y-5 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <Field label="Distrito" htmlFor="dc_district">
              <input id="dc_district" name="district" placeholder="Pucusana" className={FIELD} required />
            </Field>
            <Field label="Cobertura" htmlFor="dc_coverage">
              <select id="dc_coverage" name="coverage" className={FIELD} defaultValue="agencia">
                <option value="agencia">Agencia</option>
                <option value="provincia_cod">Provincia COD</option>
                <option value="lima">Lima</option>
              </select>
            </Field>
            <Field label="Motivo" htmlFor="dc_note" className="sm:col-span-2">
              <input
                id="dc_note"
                name="note"
                placeholder="El reparto propio no llega; sale por agencia"
                className={FIELD}
              />
            </Field>
          </div>
          <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-ink-700 pointer-coarse:min-h-11">
            <input type="checkbox" name="all_stores" defaultChecked className={CHECKBOX} />
            Todas las tiendas
          </label>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <OpsButton type="submit" variant="primary" disabled={pending}>
              {pending ? "Guardando…" : "Guardar excepción"}
            </OpsButton>
          </div>
          <ActionResult state={state} />
        </form>
      </div>
    </SettingsSection>
  );
}

/* ── Sistema ─────────────────────────────────────────────────────────────── */

const DATE_TIME = new Intl.DateTimeFormat("es-PE", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Lima",
});

function when(iso: string | null): string {
  return iso ? DATE_TIME.format(new Date(iso)) : "—";
}

/** Cabecera de una tabla de filas que en el teléfono se vuelven tarjetas. */
function GridHead({ cols, children }: { cols: string; children: ReactNode }) {
  return (
    <div
      aria-hidden
      className={cn("hidden gap-x-4 px-4 py-2.5 text-xs font-semibold leading-4 text-ink-600 sm:grid sm:px-5", cols)}
    >
      {children}
    </div>
  );
}

function SystemSections({ data }: { data: StoreSettingsData }) {
  const s = data.store;
  const syncCols = "sm:grid-cols-[minmax(0,1fr)_6rem_9rem_minmax(0,1.2fr)]";
  const hookCols = "sm:grid-cols-[9rem_minmax(0,1fr)_6.5rem_minmax(0,1.4fr)]";
  return (
    <>
      <SettingsSection id="sincronizacion" title="Estado de sincronización">
        <div className={cn(CARD, "divide-y divide-line")}>
          <ActionRow
            action={syncNow}
            storeId={s.id}
            title="Sincronización manual"
            label="Sincronizar ahora"
            help="Reconcilia órdenes de Shopify, jala conversaciones de Kapso y captura un snapshot operativo."
          />
          {data.sync.length === 0 ? (
            <EmptyRow>Aún no se ha ejecutado ninguna sincronización.</EmptyRow>
          ) : (
            <div>
              <GridHead cols={syncCols}>
                <span>Fuente</span>
                <span>Estado</span>
                <span>Última corrida</span>
                <span>Cursor · error</span>
              </GridHead>
              <ul className="divide-y divide-line border-t border-line">
                {data.sync.map((r) => (
                  <li key={r.source} className={cn("grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:px-5", syncCols)}>
                    <span className="font-medium text-ink-900">{sourceLabel(r.source)}</span>
                    <span>
                      <Badge tone={r.status === "error" ? "crit" : r.status === "ok" ? "ok" : "neutral"}>
                        {r.status === "error" ? "Error" : r.status === "ok" ? "Correcta" : (r.status ?? "—")}
                      </Badge>
                    </span>
                    <span className="tabular-nums text-ink-700">{when(r.last_run_at)}</span>
                    <span className="min-w-0 break-all text-[13px] leading-5">
                      {r.error ? (
                        <span className="text-crit-fg">{r.error}</span>
                      ) : (
                        <span className="font-mono text-xs text-ink-500">{r.cursor ?? "—"}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className={cn(ROW, "py-3", HELP)}>
            Último snapshot operativo: <span className="tabular-nums">{when(data.lastOpsAt)}</span> · eventos de
            webhook recibidos: <span className="tabular-nums">{data.webhookCount.toLocaleString("es-PE")}</span>
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        id="webhooks"
        title="Registro de webhooks recibidos"
        description="Últimos 30 eventos · recarga la página para actualizar."
      >
        <div className={CARD}>
          {data.webhookEvents.length === 0 ? (
            <EmptyRow>Aún no se han recibido webhooks.</EmptyRow>
          ) : (
            <>
              <GridHead cols={hookCols}>
                <span>Recibido</span>
                <span>Tipo</span>
                <span>Estado</span>
                <span>Detalle</span>
              </GridHead>
              <ul className="divide-y divide-line sm:border-t sm:border-line">
                {data.webhookEvents.map((r) => (
                  <li key={r.id} className={cn("grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:px-5", hookCols)}>
                    <span className="whitespace-nowrap tabular-nums text-ink-700">{when(r.received_at)}</span>
                    <span className="font-medium text-ink-900">{webhookTopicLabel(r.topic)}</span>
                    <span>
                      {r.error ? (
                        <Badge tone="crit">Error</Badge>
                      ) : r.processed ? (
                        <Badge tone="ok">Procesado</Badge>
                      ) : (
                        <Badge>Pendiente</Badge>
                      )}
                    </span>
                    <span className="min-w-0 break-all text-[13px] leading-5">
                      {r.error ? (
                        <span className="text-crit-fg">{r.error}</span>
                      ) : (
                        <span className="tabular-nums text-ink-500">{r.shopify_id ?? "—"}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </SettingsSection>
    </>
  );
}

/* ── Meta Ads: cuentas publicitarias ─────────────────────────────────────── */

/** Trae las cuentas publicitarias a las que llega el token guardado y deja
 *  elegir VARIAS para esta tienda: su gasto sumado alimenta el ROAS. */
function MetaAdAccountPicker({ storeId, current }: { storeId: string; current: StoreMetaAdAccount[] }) {
  const [accounts, setAccounts] = useState<MetaAdAccount[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(current.map((a) => a.id)));
  const [saved, setSaved] = useState<StoreMetaAdAccount[]>(current);
  const [msg, setMsg] = useState<{ error?: string; notice?: string } | null>(null);
  const [testResult, setTestResult] = useState<MetaConnectionProbe | null>(null);
  const [pending, startTransition] = useTransition();
  const [testing, startTesting] = useTransition();
  const [backfilling, startBackfill] = useTransition();

  function fetchAccounts() {
    setMsg(null);
    setTestResult(null);
    startTransition(async () => {
      const res = await listStoreMetaAdAccounts(storeId);
      if ("error" in res) {
        setAccounts(null);
        setMsg({ error: res.error });
        return;
      }
      setAccounts(res.accounts);
      if (!res.accounts.length) setMsg({ notice: "El token no tiene cuentas publicitarias accesibles." });
    });
  }

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function save() {
    if (!accounts) return;
    const chosen: StoreMetaAdAccount[] = accounts
      .filter((a) => selected.has(a.id))
      .map((a) => ({ id: a.id, name: a.name }));
    setMsg(null);
    startTransition(async () => {
      const res = await saveMetaAdAccounts(storeId, chosen);
      if (res.error) setMsg({ error: res.error });
      else {
        setSaved(chosen);
        setMsg({ notice: res.notice });
      }
    });
  }

  function testConnection() {
    setMsg(null);
    setTestResult(null);
    startTesting(async () => {
      const res = await testStoreMetaConnection(storeId);
      if ("error" in res) {
        setMsg({ error: res.error });
        return;
      }
      setTestResult(res.result);
    });
  }

  function backfill() {
    setMsg(null);
    startBackfill(async () => {
      const res = await backfillStoreMetaInsights(storeId);
      setMsg("error" in res ? { error: res.error } : { notice: res.notice });
    });
  }

  const dirty =
    accounts != null && (selected.size !== saved.length || saved.some((a) => !selected.has(a.id)));

  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title="Cuentas publicitarias"
        description={
          <p>
            Trae las cuentas a las que tu token tiene acceso y marca <strong>todas</strong> las que invierten para
            esta tienda (su gasto se sumará para el ROAS).
            {saved.length ? (
              <>
                {" "}
                Guardadas: <strong>{saved.map((a) => a.name || a.id).join(", ")}</strong>.
              </>
            ) : null}
          </p>
        }
      />
      <div className={cn(ROW, "space-y-3")}>
        <div className="flex flex-wrap gap-2">
          <OpsButton onClick={fetchAccounts} disabled={pending || testing}>
            {pending ? "Cargando…" : "Buscar cuentas publicitarias"}
          </OpsButton>
          <OpsButton onClick={testConnection} disabled={pending || testing || backfilling || !saved.length}>
            {testing ? "Probando Meta…" : "Probar conexión Meta"}
          </OpsButton>
          <OpsButton onClick={backfill} disabled={pending || testing || backfilling || !saved.length}>
            {backfilling ? "Cargando 90 días…" : "Sincronizar histórico (90 días)"}
          </OpsButton>
        </div>
        <p className={HELP}>
          Después del backfill inicial, Meta se actualizará automáticamente cada día y reescribirá los últimos 3 días
          para incorporar ajustes tardíos.
        </p>
        {msg?.error && <ActionResult state={{ error: msg.error }} />}
        {msg?.notice && <ActionResult state={{ notice: msg.notice }} />}
        {testResult && <MetaConnectionStatus result={testResult} />}
      </div>
      {accounts && accounts.length > 0 && (
        <>
          <ul className="divide-y divide-line">
            {accounts.map((a) => (
              <li key={a.id}>
                <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-wash sm:px-5 pointer-coarse:min-h-11">
                  <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} className={CHECKBOX} />
                  <span className="min-w-0">
                    <span className="font-medium text-ink-900">{a.name}</span>{" "}
                    <span className="text-[13px] tabular-nums text-ink-500">
                      {a.id}
                      {a.currency ? ` · ${a.currency}` : ""}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-end gap-3 px-4 py-3 sm:px-5">
            {dirty && <p className="mr-auto text-[13px] font-medium text-ink-600">Cambios sin guardar</p>}
            <OpsButton variant="primary" onClick={save} disabled={pending || !dirty}>
              {pending ? "Guardando…" : `Guardar selección (${selected.size})`}
            </OpsButton>
          </div>
        </>
      )}
    </div>
  );
}

function MetaConnectionStatus({ result }: { result: MetaConnectionProbe }) {
  const okCount = result.accounts.filter((account) => account.insightsOk).length;
  return (
    <Banner
      tone={result.ok ? "ok" : "warn"}
      role="status"
      title={result.ok ? "Conexión completa" : "Configuración incompleta"}
    >
      <p className="tabular-nums">
        Token {result.tokenValid ? "válido" : "inválido"} · Insights {okCount}/{result.accounts.length} cuentas ·{" "}
        {result.range.from} al {result.range.to}
      </p>
      {result.spendByCurrency.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {result.spendByCurrency.map((total) => (
            <span
              key={total.currency}
              className="inline-flex h-6 items-center rounded bg-white px-2 text-xs font-semibold tabular-nums text-ink-900 ring-1 ring-inset ring-line"
            >
              {new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 }).format(total.amount)} {total.currency}
            </span>
          ))}
        </div>
      )}
      {result.error && <p className="mt-2 font-medium">{result.error}</p>}
      {result.accounts.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[13px] font-semibold text-ink-900">
            Ver detalle por cuenta ({result.accounts.length})
          </summary>
          <ul className="mt-2 divide-y divide-line rounded-md bg-white px-3 ring-1 ring-inset ring-line">
            {result.accounts.map((account) => (
              <li key={account.id} className="flex items-start justify-between gap-3 py-2 text-[13px]">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 font-medium text-ink-900">
                    {account.insightsOk ? (
                      <IconCheckCircle aria-label="Insights correctos" className="size-3.5 shrink-0 text-ok-fg" />
                    ) : (
                      <IconAlert aria-label="Insights con error" className="size-3.5 shrink-0 text-crit-fg" />
                    )}
                    <span className="truncate">{account.name}</span>
                  </p>
                  <p className="truncate text-ink-500">{account.id}</p>
                  {account.error && <p className="mt-0.5 text-crit-fg">{account.error}</p>}
                </div>
                {account.insightsOk && (
                  <div className="shrink-0 text-right tabular-nums">
                    <p className="font-semibold text-ink-900">
                      {account.spend.toFixed(2)} {account.currency || ""}
                    </p>
                    <p className="text-ink-500">{account.impressions.toLocaleString("es-PE")} impresiones</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Banner>
  );
}
