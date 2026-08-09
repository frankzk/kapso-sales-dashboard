"use client";

import Link from "next/link";
import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, Section, SimpleTable } from "@/components/ui";
import { STORE_STATUSES } from "@/lib/store-settings";
import type { MetaAdAccount, MetaConnectionProbe, StoreMetaAdAccount } from "@/lib/meta-marketing";
import {
  addReplyTemplate,
  backfillStoreMetaInsights,
  deleteReplyTemplate,
  generateAliclikWebhookSecret,
  generateKapsoWebhookSecret,
  setReplyTemplateActive,
  listStoreMetaAdAccounts,
  reRegisterWebhooks,
  saveMetaAdAccounts,
  sendTelegramTest,
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
    telegram_chat_id: string | null;
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
    anthropicKey: boolean;
    aliclikToken: boolean;
    aliclikWebhookSecret: boolean;
    tandersPassword: boolean;
    shalomProPassword: boolean;
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
  // El estado de «Probar conexión» vive acá y no dentro de ShalomSection porque
  // lo necesitan los dos hermanos: la sección lo muestra, y el formulario de
  // abajo saca de ahí el catálogo para el desplegable de «tipo de paquete».
  const [shalomTest, shalomTestAction, shalomTestPending] = useActionState(
    testShalomConnection,
    initial,
  );
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

      <AliclikSection
        siteUrl={data.siteUrl}
        storeId={s.id}
        hasToken={data.has.aliclikToken}
        hasSecret={data.has.aliclikWebhookSecret}
        enabled={s.aliclik_enabled}
      />

      <ShalomSection
        storeId={s.id}
        hasAccount={data.has.shalomProPassword && Boolean(s.shalom_pro_email)}
        email={s.shalom_pro_email}
        originTerminalId={s.shalom_origin_terminal_id}
        originTerminalName={s.shalom_origin_terminal_name}
        testState={shalomTest}
        testAction={shalomTestAction}
        testPending={shalomTestPending}
      />

      <SettingsForm data={data} shalomProducts={shalomTest.shalomProducts} />

      <ReplyTemplatesSection storeId={s.id} rows={data.replyTemplates} />

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


/**
 * Shalom · crear preguías por API.
 *
 * Dos cosas que la interfaz tiene que dejar hacer sin salir de acá, porque si no
 * hay que irse a una terminal:
 *
 *  · **Probar conexión** — comprueba la API key global y la cuenta de la tienda
 *    por separado, y lista los productos. Es la sonda del repo, en un clic. Da
 *    aviso de que TARDA: la primera vez son ~90 s de login real contra Shalom.
 *  · **Buscar agencia** — el id de la agencia de origen se configura abajo y no
 *    hay otra forma de averiguarlo. Esto lo busca por texto y lo imprime.
 *
 * Las dos son de solo lectura: no crean ninguna guía.
 */
function ShalomSection({
  storeId,
  hasAccount,
  email,
  originTerminalId,
  originTerminalName,
  testState,
  testAction,
  testPending,
}: {
  storeId: string;
  hasAccount: boolean;
  email: string | null;
  originTerminalId: number | null;
  originTerminalName: string | null;
  testState: SettingsState;
  testAction: (fd: FormData) => void;
  testPending: boolean;
}) {
  const [agencyState, agencyAction, agencyPending] = useActionState(findShalomAgencies, initial);

  return (
    <Section
      title="Shalom · crear preguías por API"
      subtitle="Permite emitir la guía de Shalom desde el Master en vez de cargarla a mano en pro.shalom.pe. No reemplaza la carga del reporte Excel: los envíos creados acá se cruzan con él por número de guía."
    >
      <Card>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              {hasAccount ? (
                <span className="font-medium text-emerald-700">✓ Cuenta de Shalom Pro configurada</span>
              ) : (
                <span className="font-medium text-amber-700">⚠ Sin cuenta de Shalom Pro</span>
              )}
              {email && <span className="ml-3 text-slate-500">{email}</span>}
              <span className="ml-3 text-slate-500">
                {originTerminalId
                  ? `Origen: ${originTerminalName ?? "agencia"} (#${originTerminalId})`
                  : "Sin agencia de origen"}
              </span>
            </p>
            <form action={testAction}>
              <input type="hidden" name="store_id" value={storeId} />
              <button
                type="submit"
                disabled={testPending}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {testPending ? "Probando… (hasta 2 min)" : "Probar conexión"}
              </button>
            </form>
          </div>

          <p className="text-xs text-slate-500">
            La prueba puede tardar <strong>hasta 2 minutos la primera vez</strong>: Shalom hace un
            inicio de sesión real. Después la sesión queda caliente 2 horas y todo va rápido. Es solo
            lectura — no crea ninguna guía.
          </p>

          <ActionResult state={testState} />

          <div className="border-t border-slate-100 pt-4">
            <form action={agencyAction} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="store_id" value={storeId} />
              <label className="flex-1">
                <span className="text-xs text-slate-500">
                  Buscar agencia (para conseguir el id de la de origen)
                </span>
                <input
                  name="shalom_agency_q"
                  placeholder="breña, arequipa, av parra…"
                  className={inputCls}
                />
              </label>
              <button
                type="submit"
                disabled={agencyPending}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {agencyPending ? "Buscando…" : "Buscar"}
              </button>
            </form>
            <ActionResult state={agencyState} />
          </div>
        </div>
      </Card>
    </Section>
  );
}

/** Resultado de una acción de ajustes, respetando los saltos de línea. */
function ActionResult({ state }: { state: SettingsState }) {
  if (!state.error && !state.notice) return null;
  return (
    <pre
      className={`mt-3 overflow-x-auto rounded-lg px-3 py-2 font-sans text-xs whitespace-pre-wrap ${
        state.error ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-800"
      }`}
    >
      {state.error ?? state.notice}
    </pre>
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
  const [secretState, secretAction, secretPending] = useActionState(
    generateAliclikWebhookSecret,
    initial,
  );
  const [testState, testAction, testPending] = useActionState(testAliclikConnection, initial);
  const [syncState, syncAction, syncPending] = useActionState(syncAliclikCatalogNow, initial);
  const revealed = secretState.aliclikSecret ?? null;
  const url = revealed
    ? `${siteUrl}/api/webhooks/aliclik/${storeId}?secret=${revealed}`
    : `${siteUrl}/api/webhooks/aliclik/${storeId}?secret=${
        hasSecret ? "<TU_SECRETO_DE_ESTA_TIENDA>" : "<GENERA_EL_SECRETO_ABAJO>"
      }`;
  const [copied, setCopied] = useState(false);

  return (
    <Section
      title="Aliclik · crear guías por API"
      subtitle="Permite crear el pedido en Aliclik desde el Master, en vez de cargarlo a mano en su panel. El token lo entrega el equipo de Aliclik tras el alta como integrador."
    >
      <Card>
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              {hasToken ? (
                <span className="font-medium text-emerald-700">✓ Token configurado</span>
              ) : (
                <span className="font-medium text-amber-700">⚠ Sin token de Aliclik</span>
              )}
              <span className="ml-3 text-slate-500">
                {enabled ? "Creación de guías ACTIVADA" : "Creación de guías desactivada"}
              </span>
            </p>
            <div className="flex gap-2">
              <form action={testAction}>
                <input type="hidden" name="store_id" value={storeId} />
                <button
                  type="submit"
                  disabled={testPending || !hasToken}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {testPending ? "Probando…" : "Probar conexión"}
                </button>
              </form>
              <form action={syncAction}>
                <input type="hidden" name="store_id" value={storeId} />
                <button
                  type="submit"
                  disabled={syncPending || !hasToken}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {syncPending ? "Sincronizando…" : "Sincronizar catálogo"}
                </button>
              </form>
            </div>
          </div>

          {/* `whitespace-pre-line`: el resultado de la prueba compara las dos
              salidas en líneas separadas, y sin esto se leería como un párrafo
              corrido justo cuando importa distinguirlas. */}
          {testState.error ? (
            <p className="whitespace-pre-line text-sm text-rose-600">{testState.error}</p>
          ) : null}
          {testState.notice ? (
            <p className="whitespace-pre-line text-sm text-emerald-700">{testState.notice}</p>
          ) : null}
          {syncState.error ? <p className="text-sm text-rose-600">{syncState.error}</p> : null}
          {syncState.notice ? <p className="text-sm text-emerald-700">{syncState.notice}</p> : null}

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-medium text-slate-700">Dos llaves para escribir en Aliclik</p>
            <p className="mt-1">
              Crear una guía es irreversible y con ventanas de cancelación estrictas, así que hacen
              falta las dos: el interruptor de esta tienda (abajo, en «Rotar credenciales») y la
              variable de entorno <code>ALICLIK_WRITE_ENABLED=true</code>. Sin ambas, el panel cotiza
              pero no crea.
            </p>
          </div>

          <div className="border-t border-slate-200 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                {hasSecret ? (
                  <span className="font-medium text-emerald-700">✓ Webhook con secreto propio</span>
                ) : (
                  <span className="font-medium text-amber-700">
                    ⚠ Sin secreto de webhook — genera uno antes de pegar la URL en Aliclik
                  </span>
                )}
              </p>
              <form action={secretAction}>
                <input type="hidden" name="store_id" value={storeId} />
                <button
                  type="submit"
                  disabled={secretPending}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {secretPending ? "Generando…" : hasSecret ? "Regenerar secreto" : "Generar secreto"}
                </button>
              </form>
            </div>

            {secretState.error ? (
              <p className="mt-2 text-sm text-rose-600">{secretState.error}</p>
            ) : null}

            {revealed ? (
              <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900">
                <p className="font-semibold">Secreto generado. Cópialo ahora — no se vuelve a mostrar.</p>
                <code className="mt-1 block break-all rounded bg-white px-2 py-1 text-emerald-800">
                  {revealed}
                </code>
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap items-stretch gap-2">
              <code className="min-w-0 flex-1 break-all rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                {url}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                {copied ? "Copiado" : "Copiar"}
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Pégala en «Webhook de notificaciones» del panel de Aliclik. Aliclik no firma sus avisos,
              así que este secreto es lo único que impide que un tercero inyecte cambios de estado.
            </p>
          </div>
        </div>
      </Card>
    </Section>
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

function SettingsForm({
  data,
  shalomProducts,
}: {
  data: StoreSettingsData;
  shalomProducts?: SettingsState["shalomProducts"];
}) {
  const [state, action, pending] = useActionState(updateStore, initial);
  const router = useRouter();
  const s = data.store;

  // Server actions reset uncontrolled form fields to their previous defaults.
  // Refresh the server component after a successful save so toggles and secret
  // indicators immediately reflect the values that were persisted.
  useEffect(() => {
    if (state.notice === "Tienda actualizada.") router.refresh();
  }, [router, state]);

  // El `router.refresh()` de arriba no bastaba. React 19 resetea el formulario
  // al terminar la acción, y un campo NO controlado vuelve al `defaultValue`
  // que tenía AL MONTARSE: cambiar la prop no mueve la selección del DOM. Con
  // eso, "Crear guías en Aliclik" se guardaba como `true` en la base y acto
  // seguido la pantalla volvía a pintar "Deshabilitado" — el usuario veía un
  // fallo donde no lo había. La `key` cambia solo cuando cambia lo PERSISTIDO,
  // así que el formulario se vuelve a montar tras guardar (y solo entonces) y
  // cada `defaultValue` se aplica de nuevo. Vale para todos los selectores de
  // la pantalla, no solo el de Aliclik: todos tenían el mismo fallo latente.
  const persistedKey = JSON.stringify([data.store, data.has]);

  return (
    <Card>
      <form key={persistedKey} action={action} className="space-y-5">
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
            Secuencia de carritos abandonados
          </legend>
          <p className="text-xs text-slate-500">
            A los <strong>carritos abandonados</strong> (formulario COD de Shopify) se les envían
            hasta <strong>2 plantillas de WhatsApp</strong>, contadas desde que el cliente dejó el
            carrito, dentro del horario configurado. Corre en paralelo a la gestión de las
            asesoras (no cambia el estado del lead) y <strong>se detiene sola</strong> si el
            cliente compra, responde, el carrito se completa o el lead se marca ganado/perdido.
            Requiere las plantillas <strong>aprobadas por Meta</strong> con 4 variables:{" "}
            {"{{1}}"} nombre, {"{{2}}"} producto(s) x cantidad, {"{{3}}"} precio y {"{{4}}"}{" "}
            dirección (formato y textos en <code>docs/carritos-secuencia-whatsapp.md</code>).
            Cada envío queda en el historial del lead.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="cart_seq_enabled">Envío automático</label>
              <select
                id="cart_seq_enabled"
                name="cart_seq_enabled"
                defaultValue={s.cart_seq_enabled ? "true" : "false"}
                className={inputCls}
              >
                <option value="false">Deshabilitado</option>
                <option value="true">Habilitado</option>
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="cart_seq_hour_start">Enviar desde (hora local)</label>
              <input
                id="cart_seq_hour_start"
                name="cart_seq_hour_start"
                type="number"
                min={0}
                max={23}
                defaultValue={s.cart_seq_hour_start}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="cart_seq_hour_end">Enviar hasta (hora local)</label>
              <input
                id="cart_seq_hour_end"
                name="cart_seq_hour_end"
                type="number"
                min={1}
                max={24}
                defaultValue={s.cart_seq_hour_end}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="cart_seq_hours_1">Mensaje 1: horas tras el abandono</label>
              <input
                id="cart_seq_hours_1"
                name="cart_seq_hours_1"
                type="number"
                min={1}
                max={168}
                defaultValue={s.cart_seq_hours_1}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="cart_seq_template_1_name">Plantilla 1 · nombre</label>
              <input
                id="cart_seq_template_1_name"
                name="cart_seq_template_1_name"
                defaultValue={s.cart_seq_template_1_name ?? ""}
                placeholder="carrito_abandonado_1"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="cart_seq_template_1_language">Plantilla 1 · idioma</label>
              <input
                id="cart_seq_template_1_language"
                name="cart_seq_template_1_language"
                defaultValue={s.cart_seq_template_1_language ?? ""}
                placeholder="es"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="cart_seq_hours_2">Mensaje 2: horas tras el abandono</label>
              <input
                id="cart_seq_hours_2"
                name="cart_seq_hours_2"
                type="number"
                min={1}
                max={336}
                defaultValue={s.cart_seq_hours_2}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="cart_seq_template_2_name">Plantilla 2 · nombre</label>
              <input
                id="cart_seq_template_2_name"
                name="cart_seq_template_2_name"
                defaultValue={s.cart_seq_template_2_name ?? ""}
                placeholder="carrito_abandonado_2"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="cart_seq_template_2_language">Plantilla 2 · idioma</label>
              <input
                id="cart_seq_template_2_language"
                name="cart_seq_template_2_language"
                defaultValue={s.cart_seq_template_2_language ?? ""}
                placeholder="es"
                className={inputCls}
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Recuperar pedidos devueltos
          </legend>
          <p className="text-xs text-slate-500">
            A la clienta cuya guía de <strong>provincia contraentrega</strong> volvió al almacén se
            le escribe una plantilla proponiéndole <strong>reenviar por agencia con adelanto</strong>.
            Quien <strong>rechazó el producto teniéndolo delante queda fuera</strong> (MOM §11).
            Son <strong>dos interruptores</strong>: el primero abre la cola y su botón, el segundo
            deja que el envío salga solo — el mensaje pide dinero por adelantado, así que conviene
            mirar el primer lote antes de soltarlo. La respuesta la atiende el bot, que es quien
            manda el número de cuenta.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="return_recovery_enabled">Cola y botón</label>
              <select
                id="return_recovery_enabled"
                name="return_recovery_enabled"
                defaultValue={s.return_recovery_enabled ? "true" : "false"}
                className={inputCls}
              >
                <option value="false">Deshabilitado</option>
                <option value="true">Habilitado</option>
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="return_recovery_auto">Envío automático</label>
              <select
                id="return_recovery_auto"
                name="return_recovery_auto"
                defaultValue={s.return_recovery_auto ? "true" : "false"}
                className={inputCls}
              >
                <option value="false">A mano</option>
                <option value="true">Automático</option>
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="return_recovery_max_days">
                No escribir si volvió hace más de (días)
              </label>
              <input
                id="return_recovery_max_days"
                name="return_recovery_max_days"
                type="number"
                min={1}
                max={365}
                defaultValue={s.return_recovery_max_days}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="return_recovery_template_name">Plantilla · nombre</label>
              <input
                id="return_recovery_template_name"
                name="return_recovery_template_name"
                defaultValue={s.return_recovery_template_name ?? ""}
                placeholder="recuperacion_pedido_retornado"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="return_recovery_template_language">Plantilla · idioma</label>
              <input
                id="return_recovery_template_language"
                name="return_recovery_template_language"
                defaultValue={s.return_recovery_template_language ?? ""}
                placeholder="es"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="return_recovery_params">
                Orden de las variables
              </label>
              <input
                id="return_recovery_params"
                name="return_recovery_params"
                defaultValue={s.return_recovery_params ?? ""}
                placeholder="nombre,producto,monto"
                className={inputCls}
              />
              <p className="mt-1 text-xs text-slate-500">
                Uno por cada {"{{n}}"} de la plantilla, en orden. Disponibles: <code>nombre</code>,{" "}
                <code>producto</code>, <code>monto</code>, <code>pedido</code>,{" "}
                <code>distrito</code>, <code>agencia</code>. Tiene que coincidir con la plantilla
                aprobada en Meta — cada tienda tiene la suya.
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor="return_recovery_hour_start">Enviar desde (hora local)</label>
              <input
                id="return_recovery_hour_start"
                name="return_recovery_hour_start"
                type="number"
                min={0}
                max={23}
                defaultValue={s.return_recovery_hour_start}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="return_recovery_hour_end">Enviar hasta (hora local)</label>
              <input
                id="return_recovery_hour_end"
                name="return_recovery_hour_end"
                type="number"
                min={1}
                max={24}
                defaultValue={s.return_recovery_hour_end}
                className={inputCls}
              />
            </div>
            <div className="sm:col-span-3">
              <label className={labelCls} htmlFor="return_recovery_phone_number_id">
                Enviar desde otro número (opcional)
              </label>
              <input
                id="return_recovery_phone_number_id"
                name="return_recovery_phone_number_id"
                defaultValue={s.return_recovery_phone_number_id ?? ""}
                placeholder="Vacío = el número de la tienda"
                className={inputCls}
              />
              <p className="mt-1 text-xs text-slate-500">
                <strong>Solo</strong> afecta a este envío: el drip y los carritos siguen saliendo
                del número por el que escribió cada clienta, y lo demás del número de la tienda.
                Sirve para aislar el riesgo — este mensaje pide dinero por adelantado, y un reporte
                le baja la calidad a toda la WABA.
              </p>
              <p className="mt-1 text-xs text-amber-700">
                Dos condiciones: la plantilla tiene que estar <strong>aprobada en la WABA de ese
                número</strong> (si no, Meta responde <code>132001</code>), y esa línea tiene que{" "}
                <strong>atender la respuesta</strong> — la clienta acepta y alguien debe mandarle
                el número de cuenta. Un número que dispara y no escucha corta el circuito.
              </p>
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
              placeholder="-1001234567890, 8844863582"
              className={inputCls}
            />
            <p className="mt-1 text-xs text-slate-400">
              Puedes poner <strong>varios</strong> chat id separados por coma para que todas las
              notificaciones lleguen a cada uno. Cada persona debe haber abierto el bot y pulsado{" "}
              <strong>Iniciar</strong> antes de poder recibir mensajes.
            </p>
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

        <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Tanders (courier Lima)
          </legend>
          <p className="text-xs text-slate-500">
            Cuenta de <strong>tanders.app</strong> con la que se crean las guías desde el Master de
            Pedidos. Tanders no emite API keys: se usa el mismo usuario y contraseña de su web, y la
            contraseña se guarda <strong>cifrada</strong>. El origen es el almacén desde el que sale
            el paquete; sus coordenadas se sacan del enlace de Google Maps del almacén.
          </p>
          <label className="block">
            <span className="text-xs text-slate-500">Usuario (email)</span>
            <input
              name="tanders_email"
              type="email"
              defaultValue={s.tanders_email ?? ""}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <SecretField
            name="tanders_password"
            label="Contraseña de Tanders"
            set={data.has.tandersPassword}
          />
          <label className="block">
            <span className="text-xs text-slate-500">Dirección del almacén de origen</span>
            <input
              name="tanders_origin_address"
              defaultValue={s.tanders_origin_address ?? ""}
              placeholder="Jr. Restauración 525, Breña 15083, Perú"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-500">Latitud del origen</span>
              <input
                name="tanders_origin_lat"
                defaultValue={s.tanders_origin_lat ?? ""}
                placeholder="-12.0626834"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Longitud del origen</span>
              <input
                name="tanders_origin_lng"
                defaultValue={s.tanders_origin_lng ?? ""}
                placeholder="-77.0510333"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Shalom (crear guías por API)
          </legend>
          <p className="text-xs text-slate-500">
            Cuenta de <strong>pro.shalom.pe</strong> con la que se emiten las guías de esta tienda.
            La <em>API key</em> del wrapper no va acá: es de la cuenta de Kapso, la misma para todas
            las tiendas, y se configura una sola vez en el servidor (<code>SHALOM_API_KEY</code>).
            La contraseña se guarda <strong>cifrada</strong>. Dos tiendas pueden compartir la misma
            cuenta de Shalom sin problema. Esto no reemplaza la carga del reporte Excel: los envíos
            creados acá se cruzan con ese reporte por número de guía como cualquier otro.
          </p>
          <label className="block">
            <span className="text-xs text-slate-500">Email de Shalom Pro (pro.shalom.pe)</span>
            <input
              name="shalom_pro_email"
              type="email"
              defaultValue={s.shalom_pro_email ?? ""}
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <SecretField
            name="shalom_pro_password"
            label="Contraseña de Shalom Pro"
            set={data.has.shalomProPassword}
          />
          <p className="text-xs text-slate-400">
            Al cambiar el email o la contraseña se descarta el token de sesión guardado y la próxima
            guía vuelve a pagar el login (~90 s).
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-500">
                Agencia de origen (ID)
                <SavedMark set={s.shalom_origin_terminal_id != null} />
              </span>
              <input
                name="shalom_origin_terminal_id"
                inputMode="numeric"
                defaultValue={s.shalom_origin_terminal_id ?? ""}
                placeholder="404"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">
                Agencia de origen (nombre)
                <SavedMark set={Boolean(s.shalom_origin_terminal_name)} />
              </span>
              <input
                name="shalom_origin_terminal_name"
                defaultValue={s.shalom_origin_terminal_name ?? ""}
                placeholder="SALAS ICA"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs text-slate-500">
              Tipo de paquete por defecto
              <SavedMark set={s.shalom_default_product_id != null} />
            </span>
            {/* Desplegable en cuanto «Probar conexión» haya traído el catálogo.
                No se puede cargar al abrir Ajustes: leerlo exige la sesión de
                Shalom Pro, que la primera vez son ~90 s. Sin catálogo el campo
                sigue aceptando el id a mano, que es como se configuró hasta
                ahora y como se sale del paso si la cuenta no responde. */}
            {shalomProducts?.length ? (
              <select
                name="shalom_default_product_id"
                defaultValue={s.shalom_default_product_id ?? ""}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
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
                name="shalom_default_product_id"
                inputMode="numeric"
                defaultValue={s.shalom_default_product_id ?? ""}
                placeholder="1096"
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            )}
            <span className="mt-1 block text-xs text-slate-400">
              {shalomProducts?.length
                ? "Productos reales de esta cuenta, traídos por «Probar conexión». El modal deja cambiarlo por envío."
                : "El catálogo es por cuenta, así que el id no es universal y los de la documentación no valen. Pulsa «Probar conexión» arriba y este campo pasa a ser una lista."}
            </span>
          </label>
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Integración Aliclik
          </legend>
          <p className="text-xs text-slate-500">
            Token de la API de <strong>Aliclik</strong>, para leer el catálogo y crear guías de
            contraentrega desde el Master de Pedidos. Crear guías necesita <strong>dos</strong>{" "}
            llaves: este interruptor por tienda y la variable <code>ALICLIK_WRITE_ENABLED</code> del
            servidor. Con una sola, no se escribe nada en Aliclik.
          </p>
          <SecretField
            name="aliclik_api_token"
            label="Token de integración de Aliclik"
            set={data.has.aliclikToken}
          />
          <div>
            <label className={labelCls} htmlFor="aliclik_enabled">
              Crear guías en Aliclik
              <span className="ml-1 text-xs text-slate-500">
                · necesita además ALICLIK_WRITE_ENABLED
              </span>
            </label>
            <select
              id="aliclik_enabled"
              name="aliclik_enabled"
              defaultValue={s.aliclik_enabled ? "true" : "false"}
              className={inputCls}
            >
              <option value="false">Deshabilitado</option>
              <option value="true">Habilitado</option>
            </select>
          </div>
        </fieldset>

        <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Lectura de comprobantes Yape
          </legend>
          <p className="text-xs text-slate-500">
            Clave de <strong>Anthropic</strong> de esta tienda. Se usa para dos cosas: decidir si
            una captura del cliente es un comprobante Yape real (la alerta de{" "}
            <em>Yape/Shalom por verificar</em>) y <strong>transcribir</strong> el comprobante en el
            Master de Pedidos —nº de operación, monto, fecha y hora— para que nadie tenga que
            teclearlo. Cada tienda usa <strong>su propia clave</strong>, así que el gasto de cada una
            es independiente.
          </p>
          <SecretField
            name="anthropic_api_key"
            label="API key de Anthropic"
            set={data.has.anthropicKey}
          />
          <label className="block">
            <span className="text-xs text-slate-500">
              Modelo (opcional — vacío usa el valor por defecto)
            </span>
            <input
              name="anthropic_model"
              defaultValue={s.anthropic_model ?? ""}
              placeholder="claude-sonnet-5"
              className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
          </label>
          <p className="text-xs text-slate-500">
            Sin clave, la detección se queda solo en el texto del mensaje (nunca dispara la alerta
            con una captura cualquiera) y el equipo escribe a mano el nº de operación. Recuerda que{" "}
            <strong>sin nº de operación un pago no se puede validar</strong>.
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

/**
 * El catálogo de plantillas que el asesor puede mandar desde el drawer cuando la
 * ventana de 24 h ya se cerró.
 *
 * Va en su propia tarjeta, fuera del formulario grande, por dos razones: son
 * filas —se agregan y se retiran de a una, no se «guardan» todas juntas— y un
 * `<form>` no puede anidarse dentro de otro.
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
    <Section
      title="Plantillas de respuesta"
      subtitle="Lo único que se puede enviar cuando la ventana de 24h del cliente ya se cerró."
    >
      <Card>
        <p className="text-xs text-slate-500">
          Fuera de las 24h desde el último mensaje del cliente, WhatsApp no deja mandar texto libre.
          Lo que se cargue acá es lo que el asesor verá en el chat para poder responder igual. El
          nombre y el idioma tienen que ser los <strong>aprobados en Meta</strong>: cada tienda es una
          WABA distinta, así que no se pueden compartir entre tiendas.
        </p>

        {rows.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-200 rounded-xl border border-slate-200">
            {rows.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 grow">
                  <p className="text-sm font-medium text-slate-800">
                    {t.label}
                    {!t.active && (
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                        retirada
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500">
                    <code>{t.template_name}</code> · {t.language}
                    {t.params ? ` · ${t.params}` : " · sin variables"}
                  </p>
                  {t.body_preview && (
                    <p className="mt-1 text-xs whitespace-pre-wrap text-slate-600">{t.body_preview}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => toggle(t.id, !t.active)}
                    disabled={rowPending}
                    className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                  >
                    {t.active ? "Retirar" : "Activar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(t.id, t.label)}
                    disabled={rowPending}
                    className="rounded-lg border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-60"
                  >
                    Eliminar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {rowMsg && <p className="mt-2 text-sm text-slate-600">{rowMsg}</p>}

        <form action={formAction} className="mt-4 space-y-4 rounded-xl border border-slate-200 p-4">
          <input type="hidden" name="store_id" value={storeId} />
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="rt_label">
                Nombre visible
              </label>
              <input id="rt_label" name="label" placeholder="Retomar pedido" className={inputCls} />
              <p className="mt-1 text-xs text-slate-500">Lo que lee el asesor en el desplegable.</p>
            </div>
            <div>
              <label className={labelCls} htmlFor="rt_template_name">
                Nombre en Meta
              </label>
              <input
                id="rt_template_name"
                name="template_name"
                placeholder="retomar_pedido_v1"
                className={inputCls}
              />
              <p className="mt-1 text-xs text-slate-500">Minúsculas, números y guion bajo.</p>
            </div>
            <div>
              <label className={labelCls} htmlFor="rt_language">
                Idioma
              </label>
              <input id="rt_language" name="language" placeholder="es" className={inputCls} />
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor="rt_params">
              Orden de las variables
            </label>
            <input id="rt_params" name="params" placeholder="nombre,producto" className={inputCls} />
            <p className="mt-1 text-xs text-slate-500">
              Uno por cada {"{{n}}"} de la plantilla, en orden. Disponibles: <code>nombre</code>,{" "}
              <code>producto</code>, <code>monto</code>, <code>distrito</code>, <code>tienda</code>.
              Se pre-rellenan con los datos del lead y el asesor puede corregirlos antes de enviar.
              Déjalo vacío si la plantilla no lleva variables.
            </p>
          </div>
          <div>
            <label className={labelCls} htmlFor="rt_body_preview">
              Cuerpo aprobado (opcional)
            </label>
            <textarea
              id="rt_body_preview"
              name="body_preview"
              rows={3}
              placeholder="Hola {{1}}, tu {{2}} sigue disponible…"
              className={inputCls}
            />
            <p className="mt-1 text-xs text-slate-500">
              Cópialo tal cual de Meta, con los {"{{n}}"} sin reemplazar. No se envía: sirve para que
              el asesor lea lo que va a mandar en vez de elegir a ciegas por el nombre.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
            >
              {pending ? "Agregando…" : "Agregar plantilla"}
            </button>
            {state.error && <span className="text-sm text-red-600">{state.error}</span>}
            {state.notice && <span className="text-sm text-emerald-600">{state.notice}</span>}
          </div>
        </form>
      </Card>
    </Section>
  );
}

/**
 * «· guardado» para un campo normal, con el mismo lenguaje que usa
 * `SecretField` para los cifrados.
 *
 * Existe porque un `<input>` con un valor dentro no distingue entre «esto está
 * guardado en la base» y «esto es texto que escribí y todavía no he guardado» —
 * y el que configura una tienda necesita saberlo antes de irse de la pantalla.
 * Marca lo que hay EN LA BASE, así que sigue diciendo «guardado» mientras
 * editas encima; lo que confirma el guardado es el aviso del botón.
 */
function SavedMark({ set }: { set: boolean }) {
  return (
    <span className={`ml-1 text-xs ${set ? "text-emerald-600" : "text-slate-400"}`}>
      {set ? "· guardado" : "· sin definir"}
    </span>
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
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={fetchAccounts}
            disabled={pending || testing}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {pending ? "Cargando…" : "Buscar cuentas publicitarias"}
          </button>
          <button
            type="button"
            onClick={testConnection}
            disabled={pending || testing || backfilling || !saved.length}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {testing ? "Probando Meta…" : "Probar conexión Meta"}
          </button>
          <button
            type="button"
            onClick={backfill}
            disabled={pending || testing || backfilling || !saved.length}
            className="rounded-lg border border-brand-300 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-800 hover:bg-brand-100 disabled:opacity-50"
          >
            {backfilling ? "Cargando 90 días…" : "Sincronizar histórico (90 días)"}
          </button>
        </div>
        <p className="text-xs text-slate-400">
          Después del backfill inicial, Meta se actualizará automáticamente cada día y reescribirá
          los últimos 3 días para incorporar ajustes tardíos.
        </p>
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
        {testResult && <MetaConnectionStatus result={testResult} />}
      </div>
    </Card>
  );
}

function MetaConnectionStatus({ result }: { result: MetaConnectionProbe }) {
  const okCount = result.accounts.filter((account) => account.insightsOk).length;
  const tone = result.ok
    ? "border-emerald-200 bg-emerald-50 text-emerald-950"
    : "border-amber-200 bg-amber-50 text-amber-950";
  return (
    <div className={`rounded-xl border p-3 ${tone}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">
            {result.ok ? "✓ Conexión completa" : "⚠ Configuración incompleta"}
          </p>
          <p className="mt-0.5 text-xs opacity-75">
            Token {result.tokenValid ? "válido" : "inválido"} · Insights {okCount}/{result.accounts.length} cuentas ·{" "}
            {result.range.from} al {result.range.to}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {result.spendByCurrency.map((total) => (
            <span key={total.currency} className="rounded-md bg-white/70 px-2 py-1 text-xs font-semibold tabular-nums">
              {new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 }).format(total.amount)} {total.currency}
            </span>
          ))}
        </div>
      </div>
      {result.error && <p className="mt-2 text-xs font-medium">{result.error}</p>}
      {result.accounts.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium">
            Ver detalle por cuenta ({result.accounts.length})
          </summary>
          <ul className="mt-2 divide-y divide-black/5 rounded-lg bg-white/60 px-2">
            {result.accounts.map((account) => (
              <li key={account.id} className="flex items-start justify-between gap-3 py-2 text-xs">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    <span className={account.insightsOk ? "text-emerald-600" : "text-red-600"}>●</span>{" "}
                    {account.name}
                  </p>
                  <p className="truncate opacity-60">{account.id}</p>
                  {account.error && <p className="mt-0.5 text-red-700">{account.error}</p>}
                </div>
                {account.insightsOk && (
                  <div className="shrink-0 text-right tabular-nums">
                    <p className="font-semibold">{account.spend.toFixed(2)} {account.currency || ""}</p>
                    <p className="opacity-60">{account.impressions.toLocaleString("es-PE")} impresiones</p>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
