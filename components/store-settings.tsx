"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Card, Section, SimpleTable } from "@/components/ui";
import { STORE_STATUSES } from "@/lib/store-settings";
import {
  reRegisterWebhooks,
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
  };
  has: { shopifyToken: boolean; webhookSecret: boolean; kapsoKey: boolean };
  sync: Array<{
    source: string;
    status: string | null;
    last_run_at: string | null;
    cursor: string | null;
    error: string | null;
  }>;
  lastOpsAt: string | null;
  webhookCount: number;
}

export function StoreSettings({ data }: { data: StoreSettingsData }) {
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

      <SettingsForm data={data} />

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
    </div>
  );
}

function SettingsForm({ data }: { data: StoreSettingsData }) {
  const [state, action, pending] = useActionState(updateStore, initial);
  const s = data.store;
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
