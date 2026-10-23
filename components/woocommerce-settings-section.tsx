"use client";

// Ajustes → «WooCommerce» (MOM §37.11): el sitio, la clave del sitio, las claves
// de la API REST y el secreto de los webhooks de la tienda; «Probar conexión»;
// y la dirección que se pega en WooCommerce → Ajustes → Avanzado → Webhooks.
//
// Va en su propio archivo, fuera de store-settings.tsx, porque no guarda con
// `updateStore`: las claves se prueban antes de guardarse (woo-actions.ts).
//
// NINGÚN SECRETO LLEGA AQUÍ. La página manda solo si hay uno (`has*`); el
// secreto de webhooks recién generado vuelve UNA vez en la respuesta de la
// acción, para copiarlo. Este archivo no importa nada que arrastre
// `node:crypto`: solo las acciones de servidor y piezas de la interfaz.

import { useEffect, useRef, useTransition, useActionState, type FormEvent } from "react";
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

/** Lo que manda la página. Sin secretos: solo si hay uno. */
export interface WooSettingsView {
  siteUrl: string | null;
  siteKey: string | null;
  /** El prefijo de los pedidos en minúsculas (`KP` → `kp`), como sugerencia. */
  suggestedSiteKey: string | null;
  /** `stores.platform`: dónde crea Kapta los pedidos nuevos (no se cambia aquí). */
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
  sync: { status: string | null; last_run_at: string | null; error: string | null } | null;
  /** Pre-0273: las columnas no existen y la sección solo lo dice. */
  migrationMissing: boolean;
}

const initial: WooSettingsState = {};

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
          Falta aplicar la migración 0273 en la base. Hasta entonces la tienda no puede guardar nada de WooCommerce.
        </p>
      </SettingsSection>
    );
  }

  const apiReady = Boolean(data.siteUrl && data.siteKey && data.hasConsumerKey && data.hasConsumerSecret);
  const badge = data.lastError ? (
    <Badge tone="warn">Con error</Badge>
  ) : apiReady && data.hasWebhookSecret ? (
    <Badge tone="ok">Conectada</Badge>
  ) : apiReady || data.siteUrl ? (
    <Badge tone="warn">Incompleta</Badge>
  ) : (
    <Badge tone="neutral">Sin configurar</Badge>
  );

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
        <div className={ROW}>
          <p className="text-sm font-semibold leading-5 text-ink-900">
            {data.platform === "woocommerce"
              ? `Kapta crea los pedidos nuevos en WooCommerce${data.platformSwitchedAt ? ` (desde el ${when(data.platformSwitchedAt)})` : ""}.`
              : "Kapta crea los pedidos nuevos en Shopify."}
          </p>
          <p className={cn(HELP, "mt-0.5")}>
            Última sincronización de WooCommerce:{" "}
            {data.sync?.last_run_at
              ? `${when(data.sync.last_run_at)} · ${data.sync.status === "error" ? "con error" : "bien"}`
              : "todavía no corrió"}
            .
          </p>
        </div>
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
            5 fallos; los pedidos igual llegan por la sincronización.
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
