"use client";

// Ajustes → «WooCommerce» (MOM §38.11): el sitio, la clave del sitio, las claves
// de la API REST y el secreto de los webhooks de la tienda; «Probar conexión»;
// y la dirección que se pega en WooCommerce → Ajustes → Avanzado → Webhooks.
// Arriba, «Crear los pedidos nuevos en: Shopify / WooCommerce» (MOM §38.12),
// que cambia `stores.platform` con su propia acción y su confirmación.
//
// Va en su propio archivo, fuera de store-settings.tsx, porque no guarda con
// `updateStore`: las claves se prueban antes de guardarse (woo-actions.ts).
//
// NINGÚN SECRETO LLEGA AQUÍ. La página manda solo si hay uno (`has*`); el
// secreto de webhooks recién generado vuelve UNA vez en la respuesta de la
// acción, para copiarlo. Este archivo no importa nada que arrastre
// `node:crypto`: solo las acciones de servidor y piezas de la interfaz.

import { useEffect, useRef, useState, useTransition, useActionState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton } from "@/components/ops-ui";
import { CARD, CardHeader, CodeLine, Field, FieldGrid, HELP, ROW, SettingsSection } from "@/components/settings-ui";
import { IconCopy } from "@/components/icons";
import { copyLabel, useCopyToClipboard } from "@/components/copy-button";
import {
  generateWooWebhookSecret,
  saveWooSettings,
  testWooConnection,
  type WooSettingsState,
} from "@/app/dashboard/[storeId]/settings/woo-actions";
import { switchStorePlatform } from "@/app/dashboard/[storeId]/settings/woo-platform-actions";
import { PLATFORM_LABEL, WOO_PLATFORM_FIELDS, type StorePlatform } from "@/lib/woocommerce-platform";
import {
  wooSectionBadge,
  wooWebhooksView,
  type WooSectionBadge,
  type WooSyncStateView,
} from "@/lib/woocommerce-webhooks-view";

/** Lo que manda la página. Sin secretos: solo si hay uno. */
export interface WooSettingsView {
  siteUrl: string | null;
  siteKey: string | null;
  /** El prefijo de los pedidos en minúsculas (`KP` → `kp`), como sugerencia. */
  suggestedSiteKey: string | null;
  /**
   * `stores.platform`: dónde crea Kapta los pedidos nuevos. Lo cambia solo
   * «Crear los pedidos nuevos en» (`PlatformSwitch`, woo-platform-actions.ts),
   * nunca el formulario de las claves.
   */
  platform: string;
  platformSwitchedAt: string | null;
  hasConsumerKey: boolean;
  hasConsumerSecret: boolean;
  hasWebhookSecret: boolean;
  lastError: string | null;
  /** La dirección de entrega de los webhooks de esta tienda. */
  webhookUrl: string;
  topics: readonly string[];
  /** La fila `woo_orders` de `sync_state`, si ya corrió. */
  sync: WooSyncStateView | null;
  /**
   * La fila `woo_webhooks` de `sync_state` (MOM §38.14): la revisión de los
   * webhooks en WooCommerce, si ya corrió. `warning` es que algo falta.
   */
  webhooks: WooSyncStateView | null;
  /** Pre-0274: las columnas no existen y la sección solo lo dice. */
  migrationMissing: boolean;
}

const initial: WooSettingsState = {};

/** La chapa de la sección según `wooSectionBadge`. */
const SECTION_BADGE: Record<WooSectionBadge, ReactNode> = {
  con_error: <Badge tone="warn">Con error</Badge>,
  conectada: <Badge tone="ok">Conectada</Badge>,
  incompleta: <Badge tone="warn">Incompleta</Badge>,
  sin_configurar: <Badge tone="neutral">Sin configurar</Badge>,
};

const WHEN = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : WHEN.format(d);
}

function Result({ state }: { state: WooSettingsState }) {
  if (!state.error && !state.notice) return null;
  return (
    <Banner tone={state.error ? "crit" : "ok"} role={state.error ? "alert" : "status"}>
      <p className="whitespace-pre-line break-words">{state.error ?? state.notice}</p>
    </Banner>
  );
}

function SecretInput({ name, label, set, hint }: { name: string; label: string; set: boolean; hint?: string }) {
  return (
    <Field
      label={label}
      htmlFor={name}
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

export function WooCommerceSettingsSection({ storeId, data }: { storeId: string; data: WooSettingsView }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [saveState, saveAction, savePending] = useActionState(saveWooSettings, initial);
  const [testState, testAction, testPending] = useActionState(testWooConnection, initial);
  const [secretState, secretAction, secretPending] = useActionState(generateWooWebhookSecret, initial);
  const [, startTransition] = useTransition();
  const { state: copied, copy } = useCopyToClipboard();
  const { state: copiedSecret, copy: copySecret } = useCopyToClipboard();

  // Guardado: se vacían los campos secretos y se trae lo nuevo de la base. Con
  // error, lo escrito se queda (el formulario se envía a mano por eso).
  useEffect(() => {
    if (saveState.notice && !saveState.error) {
      formRef.current?.reset();
      router.refresh();
    }
  }, [saveState, router]);
  useEffect(() => {
    if (secretState.wooSecret) router.refresh();
  }, [secretState, router]);

  if (data.migrationMissing) {
    return (
      <SettingsSection id="woocommerce" title="WooCommerce" badge={<Badge tone="neutral">Sin migración</Badge>}>
        <p className={cn(CARD, ROW, HELP)}>
          Falta aplicar la migración 0274 en la base. Hasta entonces la tienda no puede guardar nada de WooCommerce.
        </p>
      </SettingsSection>
    );
  }

  const apiReady = Boolean(data.siteUrl && data.siteKey && data.hasConsumerKey && data.hasConsumerSecret);
  // La revisión de los webhooks (MOM §38.14): la línea, lo que falta en su
  // propio aviso si `woo_last_error` no lo dice ya, y la chapa
  // (lib/woocommerce-webhooks-view.ts, probado en
  // test/woocommerce-webhooks-view.test.ts).
  const hooks = wooWebhooksView({ webhooks: data.webhooks, lastError: data.lastError, apiReady });
  const badge = SECTION_BADGE[
    wooSectionBadge({
      lastError: data.lastError,
      webhooksFlagError: hooks.flagsError,
      apiReady,
      hasWebhookSecret: data.hasWebhookSecret,
      siteUrl: data.siteUrl,
    })
  ];

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const fd = new FormData(e.currentTarget);
    startTransition(() => (submitter?.value === "test" ? testAction(fd) : saveAction(fd)));
  }

  const revealed = secretState.wooSecret ?? null;
  const formKey = [data.siteUrl, data.siteKey, data.hasConsumerKey, data.hasConsumerSecret, data.hasWebhookSecret].join("|");

  return (
    <SettingsSection
      id="woocommerce"
      title="WooCommerce"
      badge={badge}
      description={
        <>
          <p>
            Los pedidos de la tienda WooCommerce entran al mismo Master que los de Shopify: por webhook al instante y,
            como red de seguridad, por la sincronización cada 5 minutos. Shopify sigue igual mientras tenga su token.
          </p>
          <p>
            <strong>Guardar las claves completas activa la sincronización</strong>: desde ese momento los pedidos de
            ese sitio entran al Master. No guardes aquí las claves de un sitio de prueba.
          </p>
        </>
      }
    >
      <div className={cn(CARD, "divide-y divide-line")}>
        <PlatformSwitch
          storeId={storeId}
          platform={data.platform}
          platformSwitchedAt={data.platformSwitchedAt}
          apiReady={apiReady}
        />
        <div className={cn(ROW, "space-y-1")}>
          <p className={HELP}>
            Última sincronización de WooCommerce:{" "}
            {data.sync?.last_run_at
              ? `${when(data.sync.last_run_at)} · ${
                  data.sync.status === "error" ? "con error" : data.sync.status === "warning" ? "no avanza" : "bien"
                }`
              : "todavía no corrió"}
            .
          </p>
          {hooks.showLine ? (
            <p className={HELP}>
              Revisión de los webhooks en WooCommerce (cada hora):{" "}
              {hooks.summary ? `${when(data.webhooks?.last_run_at ?? null)} · ${hooks.summary}` : "todavía no corrió"}
              .
            </p>
          ) : null}
        </div>
        {hooks.detail ? (
          <div className={ROW}>
            <Banner tone="warn" title="Webhooks en WooCommerce">
              <p className="break-words">{hooks.detail}</p>
            </Banner>
          </div>
        ) : null}
        {data.lastError ? (
          <div className={ROW}>
            <Banner tone="warn" title="Último fallo con WooCommerce">
              <p className="break-words">{data.lastError}</p>
            </Banner>
          </div>
        ) : null}
      </div>

      <form key={formKey} ref={formRef} onSubmit={onSubmit} className={cn(CARD, "divide-y divide-line")}>
        <input type="hidden" name="store_id" value={storeId} />
        <CardHeader
          title="Sitio y claves de la API"
          description="WooCommerce → Ajustes → Avanzado → API REST → Añadir clave, con permisos de lectura/escritura y un usuario «shop manager». Si cambias el sitio o las claves, se prueban antes de guardar."
        />
        <FieldGrid>
          <Field label="Dirección del sitio" htmlFor="woo_site_url" hint="Solo https, sin «/wp-json». Ejemplo: https://kenku.pe">
            <input
              id="woo_site_url"
              name="woo_site_url"
              type="url"
              inputMode="url"
              autoComplete="off"
              defaultValue={data.siteUrl ?? ""}
              placeholder="https://"
              className={FIELD}
            />
          </Field>
          <Field
            label="Clave del sitio"
            htmlFor="woo_site_key"
            hint="Va en el id de cada pedido (wc-kp-1532). Minúsculas y dígitos. No se cambia cuando ya hay pedidos."
          >
            <input
              id="woo_site_key"
              name="woo_site_key"
              autoComplete="off"
              defaultValue={data.siteKey ?? ""}
              placeholder={data.suggestedSiteKey ?? "kp"}
              className={cn(FIELD, "sm:max-w-48")}
            />
          </Field>
          <SecretInput name="woo_consumer_key" label="Consumer key (ck_…)" set={data.hasConsumerKey} />
          <SecretInput name="woo_consumer_secret" label="Consumer secret (cs_…)" set={data.hasConsumerSecret} />
          <SecretInput
            name="woo_webhook_secret"
            label="Secreto de los webhooks"
            set={data.hasWebhookSecret}
            hint="El mismo en los cuatro webhooks. Mejor genéralo abajo: sin & < > comillas ni espacios."
          />
        </FieldGrid>
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
          <div className="mr-auto min-w-0 space-y-2">
            <Result state={testState} />
            <Result state={saveState} />
          </div>
          <OpsButton type="submit" name="intent" value="test" disabled={testPending || savePending}>
            {testPending ? "Probando…" : "Probar conexión"}
          </OpsButton>
          <OpsButton type="submit" name="intent" value="save" variant="primary" disabled={savePending || testPending}>
            {savePending ? "Guardando…" : "Guardar"}
          </OpsButton>
        </div>
      </form>

      <div className={cn(CARD, "divide-y divide-line")}>
        <CardHeader
          title="Webhooks"
          description="En WooCommerce → Ajustes → Avanzado → Webhooks, crea uno por tema con esta dirección, estado «Activo», versión «WP REST API Integration v3» y el secreto de esta tienda."
          aside={
            <form
              action={secretAction}
              onSubmit={(e) => {
                if (
                  data.hasWebhookSecret &&
                  !window.confirm(
                    "Los webhooks que ya usan el secreto actual fallarán hasta que pegues el nuevo en cada uno. ¿Generar otro?",
                  )
                ) {
                  e.preventDefault();
                }
              }}
            >
              <input type="hidden" name="store_id" value={storeId} />
              <OpsButton type="submit" size="sm" disabled={secretPending} className="pointer-coarse:h-11">
                {secretPending ? "Generando…" : data.hasWebhookSecret ? "Generar otro secreto" : "Generar secreto"}
              </OpsButton>
            </form>
          }
        />
        <div className={cn(ROW, "space-y-3")}>
          {secretState.error ? <Result state={secretState} /> : null}
          {revealed ? (
            <Banner tone="ok" role="status" title="Secreto generado. Cópialo ahora: no se vuelve a mostrar.">
              <div className="mt-2 flex flex-wrap items-stretch gap-2">
                <CodeLine className="bg-white">{revealed}</CodeLine>
                <OpsButton onClick={() => copySecret(revealed)} className="h-auto min-h-9">
                  <IconCopy />
                  {copyLabel(copiedSecret)}
                </OpsButton>
              </div>
            </Banner>
          ) : null}
          <div className="flex flex-wrap items-stretch gap-2">
            <CodeLine>{data.webhookUrl}</CodeLine>
            <OpsButton onClick={() => copy(data.webhookUrl)} className="h-auto min-h-9">
              <IconCopy />
              {copyLabel(copied)}
            </OpsButton>
          </div>
          <ul className={cn(HELP, "list-disc space-y-1 pl-5")}>
            {data.topics.map((t) => (
              <li key={t}>
                <code>{t}</code>
                {t === "order.deleted" ? " (papelera: Kapta lo marca anulado, nunca lo borra)" : ""}
              </li>
            ))}
          </ul>
          <p className={HELP}>
            Al crearlo, WooCommerce manda una prueba: si la dirección es la de esta tienda, contesta 200 y el webhook
            queda activo. Si el secreto no coincide, cada aviso recibe 401 y WooCommerce desactiva el webhook después de
            5 fallos; los pedidos nuevos y sus cambios igual llegan por la sincronización, pero lo que se manda a la
            papelera solo llega por <code>order.deleted</code>. Kapta revisa cada hora (y al guardar o probar la
            conexión) que los cuatro temas tengan uno activo con esta dirección, y lo avisa arriba. Nunca los cambia: se
            arreglan en WooCommerce. La versión de la API y el secreto no los muestra WooCommerce: esos se revisan a mano
            en cada webhook.
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}

/**
 * «Crear los pedidos nuevos en: Shopify / WooCommerce» (`stores.platform`, MOM
 * §38.1 y §38.12). Decide dónde crean sus pedidos «Generar pedido», «Venta
 * telefónica» y los buscadores de productos de la tienda; la entrada de pedidos
 * de las dos plataformas no cambia.
 *
 * Pide marcar la confirmación y aceptar el diálogo. A WooCommerce solo con las
 * claves de la API guardadas (la acción, además, prueba que lean y que dejen
 * escribir); volver a Shopify se puede siempre: es la vuelta atrás.
 */
function PlatformSwitch({
  storeId,
  platform,
  platformSwitchedAt,
  apiReady,
}: {
  storeId: string;
  platform: string;
  platformSwitchedAt: string | null;
  apiReady: boolean;
}) {
  const router = useRouter();
  const current: StorePlatform = platform === "woocommerce" ? "woocommerce" : "shopify";
  const [state, action, pending] = useActionState(switchStorePlatform, {});
  const [target, setTarget] = useState<StorePlatform>(current);
  const changes = target !== current;

  // Lo guardado manda: tras un cambio (o el de otra persona) se vuelve a leer.
  useEffect(() => setTarget(current), [current]);
  useEffect(() => {
    if (state.notice && !state.error) router.refresh();
  }, [state, router]);

  return (
    <form
      action={action}
      onSubmit={(e) => {
        const texto =
          target === "woocommerce"
            ? "Desde ahora las ventas de Leads de esta tienda se crean en WooCommerce (y el buscador de productos usa su catálogo). ¿Cambiar?"
            : "Las ventas de Leads de esta tienda vuelven a crearse en Shopify. Si Shopify ya cerró, no se podrá vender desde Kapta. ¿Cambiar?";
        if (!changes || !window.confirm(texto)) e.preventDefault();
      }}
      className={cn(ROW, "space-y-3")}
    >
      <input type="hidden" name="store_id" value={storeId} />
      <fieldset>
        <legend className="text-sm font-semibold leading-5 text-ink-900">Crear los pedidos nuevos en</legend>
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
          {(["shopify", "woocommerce"] as const).map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm text-ink-900 pointer-coarse:min-h-11">
              <input
                type="radio"
                name={WOO_PLATFORM_FIELDS.target}
                value={p}
                checked={target === p}
                onChange={() => setTarget(p)}
                disabled={pending || (p === "woocommerce" && current !== "woocommerce" && !apiReady)}
              />
              {PLATFORM_LABEL[p]}
              {p === current ? <Badge tone="ok">Actual</Badge> : null}
            </label>
          ))}
        </div>
      </fieldset>
      <p className={HELP}>
        {current === "woocommerce"
          ? `«Generar pedido», «Venta telefónica» y los buscadores de productos usan WooCommerce${
              platformSwitchedAt ? ` (pasó por primera vez el ${when(platformSwitchedAt)})` : ""
            }.`
          : "«Generar pedido», «Venta telefónica» y los buscadores de productos usan Shopify."}{" "}
        Los pedidos de las dos plataformas siguen entrando al Master igual.
        {current !== "woocommerce"
          ? apiReady
            ? " Para elegir WooCommerce, la clave de la API tiene que ser de «Lectura/Escritura»: Kapta lo prueba antes de cambiar."
            : " Para elegir WooCommerce, guarda antes el sitio y las claves de la API (de «Lectura/Escritura»)."
          : ""}
      </p>
      {changes ? (
        <label className="flex items-start gap-2 text-sm text-ink-700">
          <input type="checkbox" name={WOO_PLATFORM_FIELDS.confirm} value="1" required className="mt-1" />
          <span>
            Entiendo que desde ahora las ventas de Leads de esta tienda se crean en {PLATFORM_LABEL[target]}.
          </span>
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="mr-auto min-w-0">
          <Result state={state} />
        </div>
        <OpsButton type="submit" variant={changes ? "primary" : undefined} disabled={!changes || pending}>
          {pending ? "Cambiando…" : `Cambiar a ${PLATFORM_LABEL[target]}`}
        </OpsButton>
      </div>
    </form>
  );
}
