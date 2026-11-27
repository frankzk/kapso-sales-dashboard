"use client";

// Automatizaciones › Correo · Resend (MOM §46): la clave de Resend (se escribe
// y no se vuelve a ver), cuántos clientes hay por tienda y tramo con «Subir a
// Resend» y «Descargar CSV», y las importaciones pedidas con su estado. Las
// campañas se arman y se envían en Resend.

import { useActionState } from "react";
import Link from "next/link";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton, opsButtonClass, type BadgeTone } from "@/components/ops-ui";
import { CARD, CardHeader, HELP, ROW } from "@/components/settings-ui";
import { IconDownload } from "@/components/icons";
import {
  removeResendKey,
  saveResendKey,
  uploadResendBucket,
  type ResendFormState,
} from "@/app/dashboard/automatizaciones/correo/actions";
import type { ResendImportView, ResendOrgView, ResendStoreView } from "@/lib/resend-marketing-server";
import { RESEND_BUCKETS, resendBucket, type ResendBucketInfo, type ResendImportStatus } from "@/lib/resend-marketing";

const initial: ResendFormState = {};

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

const fmt = (n: number) => n.toLocaleString("es-PE");

const STATUS: Record<ResendImportStatus, { label: string; tone: BadgeTone }> = {
  enviada: { label: "Enviada", tone: "neutral" },
  procesando: { label: "Procesando en Resend", tone: "info" },
  completada: { label: "Completada", tone: "ok" },
  fallida: { label: "Falló", tone: "crit" },
};

function FormMessage({ state }: { state: ResendFormState }) {
  if (state.error) return <p role="alert" className="text-[13px] leading-5 text-crit-fg">{state.error}</p>;
  if (state.notice) return <p role="status" className="text-[13px] leading-5 text-ok-fg">{state.notice}</p>;
  return null;
}

function KeyCard({ org, writable }: { org: ResendOrgView; writable: boolean }) {
  const [saveState, saveAction, saving] = useActionState(saveResendKey, initial);
  const [removeState, removeAction, removing] = useActionState(removeResendKey, initial);
  const connected = !!org.keyHint;
  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title="Conexión con Resend"
        description={
          connected ? (
            <>
              Clave <code className="font-mono text-ink-700">{org.keyHint}</code>, guardada el {when(org.keyUpdatedAt)}. Kapta la guarda
              cifrada y no la vuelve a mostrar.
            </>
          ) : (
            <>Pega una clave de Resend con permiso <strong>Full access</strong>. Kapta la guarda cifrada y no la vuelve a mostrar.</>
          )
        }
        aside={<Badge tone={connected ? "ok" : "neutral"}>{connected ? "Conectado" : "Sin conectar"}</Badge>}
      />
      <form action={saveAction} className={cn(ROW, "space-y-2")}>
        <input type="hidden" name="org_id" value={org.id} />
        <label htmlFor={`resend-key-${org.id}`} className="block text-[13px] font-medium text-ink-700">
          {connected ? "Cambiar la clave" : "Clave de Resend"}
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id={`resend-key-${org.id}`}
            name="api_key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="re_…"
            required
            disabled={!writable}
            className={cn(FIELD, "min-w-0 flex-1 basis-64 font-mono pointer-coarse:h-11")}
          />
          <OpsButton type="submit" variant="primary" disabled={!writable || saving} className="pointer-coarse:h-11">
            {saving ? "Probando la clave…" : "Guardar clave"}
          </OpsButton>
        </div>
        <p className={HELP}>
          En Resend: <strong>API Keys › Create API Key</strong>, permiso <strong>Full access</strong> (la de solo envío no puede
          subir contactos). Guardarla no crea nada en Resend: el tema de la tienda y el segmento del tramo se crean cuando subes esa lista.
        </p>
        <FormMessage state={saveState} />
      </form>
      {connected && (
        <form action={removeAction} className={cn(ROW, "flex flex-wrap items-center justify-between gap-3")}>
          <input type="hidden" name="org_id" value={org.id} />
          <p className={cn(HELP, "min-w-0 flex-1 basis-64")}>Quitar la clave no borra nada en Resend: los contactos que subiste siguen allá.</p>
          <OpsButton type="submit" variant="danger" size="sm" disabled={!writable || removing} className="pointer-coarse:h-11">
            {removing ? "Quitando…" : "Quitar clave"}
          </OpsButton>
          <div className="basis-full empty:hidden">
            <FormMessage state={removeState} />
          </div>
        </form>
      )}
    </div>
  );
}

function BucketRow({
  org,
  store,
  bucket,
  writable,
}: {
  org: ResendOrgView;
  store: ResendStoreView;
  bucket: ResendBucketInfo;
  writable: boolean;
}) {
  const [state, action, pending] = useActionState(uploadResendBucket, initial);
  const count = store.counts?.[bucket.key] ?? null;
  const lastImport = org.imports.find((i) => i.storeName === store.name && i.bucket === bucket.key) ?? null;
  const canUpload = writable && org.canExport && !!org.keyHint && !!count;
  const reason = !org.canExport
    ? "Subir o descargar contactos pide el permiso «Descargar la base de pedidos»."
    : !org.keyHint
      ? "Primero guarda la clave de Resend."
      : null;
  return (
    <li className={cn(ROW, "space-y-2")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <p className="text-sm font-medium leading-5 text-ink-900">
            {bucket.label}
            {bucket.key === "6m" && (
              <Badge tone="brand" className="ml-2 align-[1px]">
                Primero
              </Badge>
            )}
          </p>
          <p className={HELP}>{bucket.help}</p>
          {lastImport && (
            <p className={cn(HELP, "mt-0.5")}>
              Última subida: {when(lastImport.createdAt)} · {fmt(lastImport.rows)} contactos ·{" "}
              <span className={lastImport.status === "fallida" ? "text-crit-fg" : undefined}>{STATUS[lastImport.status].label.toLocaleLowerCase("es-PE")}</span>
            </p>
          )}
        </div>
        <p className="text-right text-[22px] font-semibold leading-7 tabular-nums text-ink-900">
          {count == null ? "—" : fmt(count)}
          <span className="block text-xs font-normal leading-4 text-ink-500">contactos</span>
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <form
          action={action}
          onSubmit={(e) => {
            const ok = window.confirm(
              `¿Subir ${count == null ? "" : `${fmt(count)} `}contactos de ${store.name} a Resend (segmento «${bucket.segment}»)? Resend cobra por contacto guardado.`,
            );
            if (!ok) e.preventDefault();
          }}
        >
          <input type="hidden" name="org_id" value={org.id} />
          <input type="hidden" name="store_id" value={store.id} />
          <input type="hidden" name="bucket" value={bucket.key} />
          <OpsButton type="submit" variant={bucket.key === "6m" ? "primary" : "secondary"} size="sm" disabled={!canUpload || pending} className="pointer-coarse:h-11">
            {pending ? "Subiendo…" : "Subir a Resend"}
          </OpsButton>
        </form>
        {org.canExport && !!count && (
          <a
            href={`/dashboard/automatizaciones/correo/csv?store=${encodeURIComponent(store.id)}&bucket=${bucket.key}`}
            className={opsButtonClass("ghost", "sm", "pointer-coarse:h-11")}
            download
          >
            <IconDownload aria-hidden />
            Descargar CSV
          </a>
        )}
        {reason && <p className={HELP}>{reason}</p>}
      </div>
      <FormMessage state={state} />
    </li>
  );
}

function StoreCard({ org, store, writable }: { org: ResendOrgView; store: ResendStoreView; writable: boolean }) {
  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title={store.name}
        description={
          <>
            Clientes que aceptaron publicidad en Shopify, por su último pedido (cancelados incluidos), sin los que se dieron de baja ni los
            correos mal escritos. En Resend van al tema <strong>{store.name}</strong> y al segmento de cada tramo.
          </>
        }
        aside={
          store.topicReady ? (
            <Badge tone="ok">Sincronizada</Badge>
          ) : (
            <Badge tone="neutral">Sin sincronizar</Badge>
          )
        }
      />
      {store.counts == null && <p className={cn(ROW, HELP)}>No pudimos contar los contactos. Recarga la página.</p>}
      <ul className="divide-y divide-line">
        {RESEND_BUCKETS.map((b) => (
          <BucketRow key={b.key} org={org} store={store} bucket={b} writable={writable} />
        ))}
      </ul>
    </div>
  );
}

function ImportsCard({ imports }: { imports: ResendImportView[] }) {
  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader title="Importaciones" description="Lo que Kapta pidió a Resend, de la más nueva a la más vieja. Resend las procesa en unos minutos." />
      {imports.length ? (
        <ul className="divide-y divide-line">
          {imports.map((i) => (
            <li key={i.id} className={cn(ROW, "flex flex-wrap items-start justify-between gap-x-4 gap-y-1")}>
              <div className="min-w-0 flex-1 basis-64">
                <p className="text-sm font-medium leading-5 text-ink-900">
                  {i.storeName} · {resendBucket(i.bucket).label.toLocaleLowerCase("es-PE")}
                </p>
                <p className={HELP}>
                  {fmt(i.rows)} contactos{i.excluded ? ` · ${fmt(i.excluded)} fuera (mal escritos o repetidos)` : ""}
                  {i.detail ? ` · ${i.detail}` : ""}
                </p>
                <p className={HELP}>
                  {when(i.createdAt)}
                  {i.createdBy ? ` · ${i.createdBy}` : ""}
                </p>
              </div>
              <Badge tone={STATUS[i.status].tone}>{STATUS[i.status].label}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className={cn(ROW, HELP)}>Todavía no subiste contactos.</p>
      )}
    </div>
  );
}

function HowToSend() {
  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader title="Cómo se envía" description="Kapta sube los contactos; la campaña se arma y se envía en Resend." />
      <ol className={cn(ROW, HELP, "list-decimal space-y-1.5 pl-9 sm:pl-10")}>
        <li>
          En Resend, <strong>Domains › Add Domain</strong> con un subdominio para correo (por ejemplo <code>news.tumarca.com</code>) y copia
          los registros SPF, DKIM y DMARC en tu DNS. Sin dominio verificado no sale nada.
        </li>
        <li>
          Sube primero <strong>Pidieron en los últimos 6 meses</strong>. Envía unos días a ese grupo y mira rebotes y quejas en Resend
          antes de subir el de 12 meses.
        </li>
        <li>
          En <strong>Broadcasts</strong>, elige el segmento («Kenku Peru · pidieron en 6 meses») y el tema de la marca. Resend pone el
          enlace para darse de baja; quien se da de baja de una marca sigue recibiendo la otra.
        </li>
        <li>Resend cobra por contacto guardado, no por envío: un correo que está en las dos tiendas cuenta una sola vez.</li>
      </ol>
    </div>
  );
}

export function ResendPanel({ orgs, writable }: { orgs: ResendOrgView[]; writable: boolean }) {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <header className="space-y-1">
        <p className="text-sm text-ink-500">
          <Link href="/dashboard/automatizaciones" className="underline">
            Automatizaciones
          </Link>{" "}
          ›
        </p>
        <h1 className="text-xl font-semibold text-ink-900">Correo · Resend</h1>
        <p className={HELP}>
          Sube a Resend los clientes que aceptaron publicidad en Shopify, por tienda y por su último pedido, para enviarles campañas de
          correo. Los datos salen del Historial de Shopify: para sumar clientes nuevos, vuelve a cargar ahí el CSV de clientes de Shopify.
        </p>
      </header>
      {!writable && (
        <Banner tone="info" title="Solo en producción">
          Esta es una vista previa: aquí no se guarda la clave ni se sube nada a Resend.
        </Banner>
      )}
      {!orgs.length && <p className={HELP}>No tienes ninguna organización donde conectar Resend.</p>}
      {orgs.map((org) => (
        <section key={org.id} className="space-y-4">
          {orgs.length > 1 && <h2 className="text-base font-semibold text-ink-900">{org.name}</h2>}
          <KeyCard org={org} writable={writable} />
          {org.stores.map((store) => (
            <StoreCard key={store.id} org={org} store={store} writable={writable} />
          ))}
          <ImportsCard imports={org.imports} />
        </section>
      ))}
      <HowToSend />
    </div>
  );
}
