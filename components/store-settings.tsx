"use client";

import Link from "next/link";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, Section, SimpleTable } from "@/components/ui";
import { STORE_STATUSES } from "@/lib/store-settings";
import type { MetaAdAccount, StoreMetaAdAccount } from "@/lib/meta-marketing";
import {
  generateKapsoWebhookSecret,
  listStoreMetaAdAccounts,
  reRegisterWebhooks,
  saveMetaAdAccounts,
  sendTelegramTest,
  syncNow,
  updateStore,
  type SettingsState,
} from "@/app/dashboard/[storeId]/settings/actions";

const initial: SettingsState = {};
const inputCls =
  "mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
const labelCls = "block text-sm font-medium text-slate-700";

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
    browse_template_enabled: boolean;
    browse_template_name: string | null;
    browse_template_language: string | null;
    winback_template_enabled: boolean;
    winback_template_name: string | null;
    winback_template_language: string | null;
    drip_template_enabled: boolean;
    drip_template_name: string | null;
    drip_template_language: string | null;
    telegram_chat_id: string | null;
    meta_ad_accounts: StoreMetaAdAccount[];
  };
  has: {
    shopifyToken: boolean;
    webhookSecret: boolean;
    kapsoKey: boolean;
    flowSecret: boolean;
    kapsoWebhookSecret: boolean;
    telegramToken: boolean;
    metaToken: boolean;
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
}

/** Friendly label for a webhook topic in the received-webhooks log. */
function webhookTopicLabel(topic: string): string {
  if (topic === "flow/abandoned_browse") return "🔎 Búsqueda abandonada";
  if (topic === "flow/unauthorized") return "🚫 Rechazado (secreto)";
  if (topic === "flow/bad_request") return "🚫 Payload inválido";
  if (topic.startsWith("draft_orders/")) return "🛒 Borrador (carrito)";
  if (topic.startsWith("orders/")) return "📦 Orden";
  return topic;
}

export function StoreSettings({
  data,
  banner,
}: {
  data: StoreSettingsData;
  banner?: { kind: "ok" | "error"; msg: string } | null;
}) {
  const s = data.store;
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Ajustes · {s.name}</h1>
          <p className="text-sm text-slate-500">{s.shopify_domain}</p>
        </div>
        <Link href={`/dashboard/${s.id}`} className="text-sm text-brand-700 hover:underline">
          ← Volver al panel
        </Link>
      </div>

      {banner && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm ${
            banner.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          {banner.msg}
        </div>
      )}

      <Section
        title="Conexión con Shopify"
        subtitle="Instala vía OAuth y el token se captura y cifra solo (sin copiar/pegar)."
      >
        <Card>
          {data.oauthAvailable ? (
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={`/api/shopify/install?storeId=${s.id}`}
                className="rounded-lg bg-[#5E8E3E] px-4 py-2 text-sm font-medium text-white hover:opacity-90"
              >
                {data.has.shopifyToken ? "Reconectar con Shopify" : "Instalar con Shopify"}
              </a>
              <span className="text-xs text-slate-500">
                {data.has.shopifyToken
                  ? "Token configurado (cifrado)."
                  : "Aún sin token — instala para activar webhooks + backfill."}
              </span>
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              OAuth no está configurado en el servidor. Configura{" "}
              <code>SHOPIFY_APP_API_KEY</code> y <code>SHOPIFY_APP_API_SECRET</code>, o pega el token
              manualmente abajo.
            </p>
          )}
        </Card>
      </Section>

      <KapsoWebhookSection siteUrl={data.siteUrl} storeId={s.id} hasSecret={data.has.kapsoWebhookSecret} />

      <SettingsForm data={data} />

      <div className="-mt-2">
        <ActionButton
          action={sendTelegramTest}
          storeId={s.id}
          label="Enviar resumen de prueba (Telegram)"
          help="Manda ahora mismo a tu Telegram el resumen del día anterior, para validar la configuración de Telegram de arriba."
        />
      </div>

      <div className="-mt-2">
        <MetaAdAccountPicker storeId={s.id} current={s.meta_ad_accounts} />
      </div>

      <Section title="Operaciones">
        <div className="grid gap-4 sm:grid-cols-2">
          <ActionButton
            action={syncNow}
            storeId={s.id}
            label="Sincronizar ahora"
            help="Reconcilia órdenes de Shopify, jala conversaciones de Kapso y captura un snapshot operativo."
          />
          <ActionButton
            action={reRegisterWebhooks}
            storeId={s.id}
            label="Re-registrar webhooks"
            help="Vuelve a registrar orders/create y orders/updated apuntando a este panel."
          />
        </div>
      </Section>

      <Section title="Estado de sincronización">
        <Card>
          <SimpleTable
            rows={data.sync}
            empty="Aún no se ha ejecutado ninguna sincronización."
            columns={[
              { key: "source", header: "Fuente", render: (r) => r.source },
              {
                key: "status",
                header: "Estado",
                render: (r) => (
                  <span className={r.status === "error" ? "text-red-600" : "text-slate-700"}>
                    {r.status ?? "—"}
                  </span>
                ),
              },
              {
                key: "last",
                header: "Última corrida",
                render: (r) => (r.last_run_at ? new Date(r.last_run_at).toLocaleString("es-PE") : "—"),
              },
              { key: "cursor", header: "Cursor", render: (r) => <span className="text-xs text-slate-400">{r.cursor ?? "—"}</span> },
              { key: "error", header: "Error", render: (r) => <span className="text-xs text-red-600">{r.error ?? ""}</span> },
            ]}
          />
          <p className="mt-3 text-xs text-slate-400">
            Último snapshot operativo: {data.lastOpsAt ? new Date(data.lastOpsAt).toLocaleString("es-PE") : "—"} ·
            eventos de webhook recibidos: {data.webhookCount}
          </p>
        </Card>
      </Section>

      <Section title="Registro de webhooks recibidos">
        <Card>
          <SimpleTable
            rows={data.webhookEvents}
            empty="Aún no se han recibido webhooks."
            columns={[
              {
                key: "received_at",
                header: "Recibido",
                render: (r) => (
                  <span className="whitespace-nowrap">{new Date(r.received_at).toLocaleString("es-PE")}</span>
                ),
              },
              { key: "topic", header: "Tipo", render: (r) => webhookTopicLabel(r.topic) },
              {
                key: "status",
                header: "Estado",
                render: (r) =>
                  r.error ? (
                    <span className="text-red-600">✗ error</span>
                  ) : r.processed ? (
                    <span className="text-emerald-700">✓ procesado</span>
                  ) : (
                    <span className="text-slate-400">⏳ pendiente</span>
                  ),
              },
              {
                key: "detail",
                header: "Detalle",
                render: (r) =>
                  r.error ? (
                    <span className="text-xs text-red-600">{r.error}</span>
                  ) : (
                    <span className="text-xs text-slate-400">{r.shopify_id ?? "—"}</span>
                  ),
              },
            ]}
          />
          <p className="mt-3 text-xs text-slate-400">Últimos 30 eventos · recarga la página para actualizar.</p>
        </Card>
      </Section>
    </div>
  );
}

function KapsoWebhookSection({
  siteUrl,
  storeId,
  hasSecret,
}: {
  siteUrl: string;
  storeId: string;
  hasSecret: boolean;
}) {
  const [state, action, pending] = useActionState(generateKapsoWebhookSecret, initial);
  const revealed = state.kapsoSecret ?? null;
  // Once a secret is minted we can show the ready-to-paste URL with the real
  // secret inlined; otherwise show a masked template (the plaintext is never
  // readable after minting, by design).
  const url = revealed
    ? `${siteUrl}/api/webhooks/kapso/${storeId}?secret=${revealed}`
    : `${siteUrl}/api/webhooks/kapso/${storeId}?secret=${
        hasSecret ? "<TU_SECRETO_DE_ESTA_TIENDA>" : "<GENERA_EL_SECRETO_ABAJO>"
      }`;
  const [copied, setCopied] = useState(false);
  return (
    <Section
      title="Webhooks de Kapso"
      subtitle="Genera un secreto exclusivo de esta tienda y pega la URL resultante en los dos webhooks de Kapso. Así los leads de esta tienda quedan aislados de las demás."
    >
      <Card>
        <div className="space-y-4">
          {/* Status + generate */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              {hasSecret ? (
                <span className="font-medium text-emerald-700">✓ Esta tienda tiene su propio secreto</span>
              ) : (
                <span className="font-medium text-amber-700">
                  ⚠ Aún sin secreto propio — genera uno antes de conectar Kapso
                </span>
              )}
            </p>
            <form action={action}>
              <input type="hidden" name="store_id" value={storeId} />
              <button
                type="submit"
                disabled={pending}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {pending ? "Generando…" : hasSecret ? "Regenerar secreto" : "Generar secreto"}
              </button>
            </form>
          </div>

          {state.error ? <p className="text-sm text-rose-600">{state.error}</p> : null}

          {revealed ? (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900">
              <p className="font-semibold">
                Secreto generado. Cópialo ahora — no se vuelve a mostrar.
              </p>
              <code className="mt-1 block break-all rounded bg-white px-2 py-1 text-emerald-800">
                {revealed}
              </code>
              <p className="mt-2 text-emerald-800">
                Regenerar invalida el anterior: recuerda actualizar la URL en los dos webhooks de
                Kapso.
              </p>
            </div>
          ) : null}

          {/* Ready-to-paste URL */}
          <div className="flex flex-wrap items-stretch gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              {url}
            </code>
            {revealed ? (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(url).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    },
                    () => {},
                  );
                }}
                className="shrink-0 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                {copied ? "¡Copiado!" : "Copiar"}
              </button>
            ) : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-800">1) WhatsApp webhook → abandonos</p>
              <p className="mt-1 text-xs text-slate-500">
                Integrations → Webhooks → tu número. Marca <strong>Conversation ended</strong> y{" "}
                <strong>Conversation inactive</strong>. Deja el <em>signing secret</em> en blanco.
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 p-3">
              <p className="text-sm font-medium text-slate-800">2) Platform webhook → leads 🔥</p>
              <p className="mt-1 text-xs text-slate-500">
                Integrations → Webhooks → pestaña <strong>Platform webhooks</strong>. Marca{" "}
                <strong>workflow.execution.handoff</strong>.
              </p>
            </div>
          </div>

          <p className="text-xs text-slate-400">
            El <code>store id</code> de esta tienda ya viene en la URL: <code>{storeId}</code>. No es
            el Project ID de Kapso.
          </p>
        </div>
      </Card>
    </Section>
  );
}

function SettingsForm({ data }: { data: StoreSettingsData }) {
  const [state, action, pending] = useActionState(updateStore, initial);
  const router = useRouter();
  const s = data.store;

  // Server actions reset uncontrolled form fields to their previous defaults.
  // Refresh the server component after a successful save so toggles and secret
  // indicators immediately reflect the values that were persisted.
  useEffect(() => {
    if (state.notice === "Tienda actualizada.") router.refresh();
  }, [router, state]);

  return (
    <Card>
      <form action={action} className="space-y-5">
        <input type="hidden" name="store_id" value={s.id} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="name">Nombre</label>
            <input id="name" name="name" defaultValue={s.name} className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="status">Estado</label>
            <select id="status" name="status" defaultValue={s.status} className={inputCls}>
              {STORE_STATUSES.map((st) => (
                <option key={st} value={st}>{st}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="currency">Moneda</label>
            <input id="currency" name="currency" defaultValue={s.currency} className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="timezone">Zona horaria</label>
            <input id="timezone" name="timezone" defaultValue={s.timezone} className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="whatsapp_phone_number_id">WhatsApp phone number id</label>
            <input
              id="whatsapp_phone_number_id"
              name="whatsapp_phone_number_id"
              defaultValue={s.whatsapp_phone_number_id ?? ""}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="kapso_project_id">Kapso project id</label>
            <input
              id="kapso_project_id"
              name="kapso_project_id"
              defaultValue={s.kapso_project_id ?? ""}
              className={inputCls}
            />
          </div>
        </div>

        <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Rotar credenciales (déjalo en blanco para conservar la actual)
          </legend>
          <SecretField name="shopify_token" label="Shopify Admin API token" set={data.has.shopifyToken} />
          <SecretField name="shopify_webhook_secret" label="Shopify API secret (HMAC)" set={data.has.webhookSecret} />
          <SecretField name="kapso_api_key" label="Kapso API key" set={data.has.kapsoKey} />
          <SecretField name="flow_webhook_secret" label="Secreto webhook de Shopify Flow (búsquedas)" set={data.has.flowSecret} />
          <SecretField name="kapso_webhook_secret" label="Secreto webhook de Kapso (leads)" set={data.has.kapsoWebhookSecret} />
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Mensaje automático de búsqueda abandonada
          </legend>
          <p className="text-xs text-slate-500">
            Cuando un cliente identificado mira un producto y se va, se le envía esta
            plantilla de WhatsApp para re-engancharlo. Solo se manda a leads{" "}
            <strong>nuevos</strong> con nombre y producto, y requiere la plantilla{" "}
            <strong>aprobada por Meta</strong>. Si el cliente responde, el bot de Kapso
            toma la conversación.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="browse_template_enabled">Envío automático</label>
              <select
                id="browse_template_enabled"
                name="browse_template_enabled"
                defaultValue={s.browse_template_enabled ? "true" : "false"}
                className={inputCls}
              >
                <option value="false">Deshabilitado</option>
                <option value="true">Habilitado</option>
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="browse_template_name">Nombre de la plantilla</label>
              <input
                id="browse_template_name"
                name="browse_template_name"
                defaultValue={s.browse_template_name ?? ""}
                placeholder="busqueda_abandonada_1"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="browse_template_language">Idioma</label>
              <input
                id="browse_template_language"
                name="browse_template_language"
                defaultValue={s.browse_template_language ?? ""}
                placeholder="es"
                className={inputCls}
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Recuperación de clientes (60 días sin comprar)
          </legend>
          <p className="text-xs text-slate-500">
            Un Shopify Flow avisa cuando un cliente lleva <strong>~60 días sin volver a
            comprar</strong> y se le envía esta plantilla de WhatsApp (cupón + botón a la
            tienda) para traerlo de vuelta. Requiere la plantilla <strong>aprobada por
            Meta</strong> y usa el mismo secreto del webhook de Flow. No crea leads: si el
            cliente responde, entra por el flujo normal de Kapso.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="winback_template_enabled">Envío automático</label>
              <select
                id="winback_template_enabled"
                name="winback_template_enabled"
                defaultValue={s.winback_template_enabled ? "true" : "false"}
                className={inputCls}
              >
                <option value="false">Deshabilitado</option>
                <option value="true">Habilitado</option>
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="winback_template_name">Nombre de la plantilla</label>
              <input
                id="winback_template_name"
                name="winback_template_name"
                defaultValue={s.winback_template_name ?? ""}
                placeholder="recuperacion_60d_1"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="winback_template_language">Idioma</label>
              <input
                id="winback_template_language"
                name="winback_template_language"
                defaultValue={s.winback_template_language ?? ""}
                placeholder="es"
                className={inputCls}
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Drip de seguimiento (no contesta)
          </legend>
          <p className="text-xs text-slate-500">
            A los leads en <strong>No responde / Buzón / Cuelga</strong> se les envía esta
            plantilla de WhatsApp automáticamente: <strong>máximo 2 toques</strong> (~6h después
            de la llamada sin respuesta y +24h el segundo), solo de <strong>9 am a 8 pm</strong>.
            Se detiene si el cliente responde o si la asesora agendó un seguimiento manual.
            Requiere la plantilla <strong>aprobada por Meta</strong> con el nombre del cliente
            como variable {"{{1}}"} (los leads sin nombre se omiten). Cada envío queda en el
            historial del lead.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="drip_template_enabled">Envío automático</label>
              <select
                id="drip_template_enabled"
                name="drip_template_enabled"
                defaultValue={s.drip_template_enabled ? "true" : "false"}
                className={inputCls}
              >
                <option value="false">Deshabilitado</option>
                <option value="true">Habilitado</option>
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="drip_template_name">Nombre de la plantilla</label>
              <input
                id="drip_template_name"
                name="drip_template_name"
                defaultValue={s.drip_template_name ?? ""}
                placeholder="seguimiento_nr_1"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="drip_template_language">Idioma</label>
              <input
                id="drip_template_language"
                name="drip_template_language"
                defaultValue={s.drip_template_language ?? ""}
                placeholder="es"
                className={inputCls}
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Resumen diario por Telegram
          </legend>
          <p className="text-xs text-slate-500">
            Cada día a las <strong>8:00 am</strong> (Perú) te llega a Telegram el resumen del día
            anterior: <strong>pedidos, ingresos y rendimiento por asesor</strong>. Crea un bot con{" "}
            <strong>@BotFather</strong>, pega su token aquí y pon el <strong>chat id</strong> del
            chat o grupo donde quieres recibirlo. Guarda y usa el botón de prueba de abajo.
          </p>
          <SecretField name="telegram_bot_token" label="Token de bot de Telegram" set={data.has.telegramToken} />
          <div>
            <label className={labelCls} htmlFor="telegram_chat_id">Chat ID de Telegram</label>
            <input
              id="telegram_chat_id"
              name="telegram_chat_id"
              defaultValue={s.telegram_chat_id ?? ""}
              placeholder="-1001234567890"
              className={inputCls}
            />
          </div>
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Meta Ads · Marketing API
          </legend>
          <p className="text-xs text-slate-500">
            Conecta la <strong>Marketing API</strong> de Meta para cruzar el <strong>gasto</strong> de
            tus anuncios con las ventas (ROAS). Pega un <strong>access token</strong> con permiso{" "}
            <code>ads_read</code> (ideal: token de un <em>system user</em>), guarda los cambios y luego
            elige la <strong>cuenta publicitaria</strong> en el botón de abajo.
          </p>
          <SecretField name="meta_access_token" label="Access token de Meta (Marketing API)" set={data.has.metaToken} />
          <p className="text-xs text-slate-500">
            Cuentas seleccionadas:{" "}
            <strong className="text-slate-700">
              {s.meta_ad_accounts.length
                ? s.meta_ad_accounts.map((a) => a.name || a.id).join(", ")
                : "ninguna"}
            </strong>
          </p>
        </fieldset>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {pending ? "Guardando…" : "Guardar cambios"}
          </button>
          {state.error && <span className="text-sm text-red-600">{state.error}</span>}
          {state.notice && <span className="text-sm text-emerald-600">{state.notice}</span>}
        </div>
      </form>
    </Card>
  );
}

function SecretField({ name, label, set }: { name: string; label: string; set: boolean }) {
  return (
    <div>
      <label className={labelCls} htmlFor={name}>
        {label}{" "}
        <span className={`ml-1 text-xs ${set ? "text-emerald-600" : "text-amber-600"}`}>
          {set ? "· configurado (cifrado)" : "· no configurado"}
        </span>
      </label>
      <input id={name} name={name} type="password" autoComplete="off" placeholder="••••••••" className={inputCls} />
    </div>
  );
}

function ActionButton({
  action,
  storeId,
  label,
  help,
}: {
  action: (prev: SettingsState, fd: FormData) => Promise<SettingsState>;
  storeId: string;
  label: string;
  help: string;
}) {
  const [state, formAction, pending] = useActionState(action, initial);
  return (
    <Card>
      <form action={formAction} className="space-y-2">
        <input type="hidden" name="store_id" value={storeId} />
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {pending ? "Ejecutando…" : label}
        </button>
        <p className="text-xs text-slate-400">{help}</p>
        {state.error && <p className="text-sm text-red-600">{state.error}</p>}
        {state.notice && <p className="text-sm text-emerald-600">{state.notice}</p>}
      </form>
    </Card>
  );
}

/** Fetch the Meta ad accounts the saved token can access, then pick + save
 *  SEVERAL for this store (multi-account). Their combined spend later powers
 *  ad-spend ↔ ventas (ROAS). */
function MetaAdAccountPicker({ storeId, current }: { storeId: string; current: StoreMetaAdAccount[] }) {
  const [accounts, setAccounts] = useState<MetaAdAccount[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set(current.map((a) => a.id)));
  const [saved, setSaved] = useState<StoreMetaAdAccount[]>(current);
  const [msg, setMsg] = useState<{ error?: string; notice?: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function fetchAccounts() {
    setMsg(null);
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

  const dirty =
    accounts != null &&
    (selected.size !== saved.length || saved.some((a) => !selected.has(a.id)));

  return (
    <Card>
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium text-slate-700">Cuentas publicitarias de Meta</p>
          <p className="text-xs text-slate-400">
            Trae las cuentas a las que tu token tiene acceso y marca <strong>todas</strong> las que
            invierten para esta tienda (su gasto se sumará para el ROAS).
            {saved.length ? (
              <>
                {" "}
                Guardadas: <strong className="text-slate-600">{saved.map((a) => a.name || a.id).join(", ")}</strong>.
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          onClick={fetchAccounts}
          disabled={pending}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {pending ? "Cargando…" : "Buscar cuentas publicitarias"}
        </button>
        {accounts && accounts.length > 0 && (
          <>
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {accounts.map((a) => (
                <li key={a.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      onChange={() => toggle(a.id)}
                      className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    />
                    <span className="min-w-0">
                      <span className="font-medium text-slate-800">{a.name}</span>{" "}
                      <span className="text-xs text-slate-400">
                        {a.id}
                        {a.currency ? ` · ${a.currency}` : ""}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={save}
              disabled={pending || !dirty}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {pending ? "Guardando…" : `Guardar selección (${selected.size})`}
            </button>
          </>
        )}
        {msg?.error && <p className="text-sm text-red-600">{msg.error}</p>}
        {msg?.notice && <p className="text-sm text-emerald-600">{msg.notice}</p>}
      </div>
    </Card>
  );
}
