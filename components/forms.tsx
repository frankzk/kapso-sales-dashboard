"use client";

import { useActionState } from "react";
import {
  createOrganization,
  createStore,
  type ActionState,
} from "@/app/dashboard/actions";

const initial: ActionState = {};

const inputCls =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
const labelCls = "block text-sm font-medium text-slate-700";
const hintCls = "mt-1 text-xs text-slate-400";

export function CreateOrgForm() {
  const [state, action, pending] = useActionState(createOrganization, initial);
  return (
    <form action={action} className="max-w-md space-y-4">
      <div>
        <label className={labelCls} htmlFor="name">
          Nombre de la organización
        </label>
        <input id="name" name="name" required placeholder="Mi empresa" className={inputCls} />
      </div>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? "Creando…" : "Crear organización"}
      </button>
    </form>
  );
}

export function CreateStoreForm({ orgs }: { orgs: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(createStore, initial);
  return (
    <form action={action} className="max-w-2xl space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelCls} htmlFor="org_id">
            Organización
          </label>
          <select id="org_id" name="org_id" required className={inputCls}>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelCls} htmlFor="name">
            Nombre de la tienda
          </label>
          <input id="name" name="name" required placeholder="Aurela" className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="shopify_domain">
            Dominio Shopify
          </label>
          <input
            id="shopify_domain"
            name="shopify_domain"
            required
            placeholder="aurela.myshopify.com"
            className={inputCls}
          />
        </div>
      </div>

      <fieldset className="space-y-4 rounded-xl border border-slate-200 p-4">
        <legend className="px-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
          Credenciales (se cifran AES-GCM en la base — nunca se exponen)
        </legend>
        <div>
          <label className={labelCls} htmlFor="shopify_token">
            Shopify Admin API access token
          </label>
          <input id="shopify_token" name="shopify_token" type="password" placeholder="shpat_…" className={inputCls} />
          <p className={hintCls}>Se valida contra la tienda y se usa para backfill + registro de webhooks.</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="shopify_webhook_secret">
            Shopify API secret (para HMAC de webhooks)
          </label>
          <input
            id="shopify_webhook_secret"
            name="shopify_webhook_secret"
            type="password"
            placeholder="shpss_…"
            className={inputCls}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="kapso_api_key">
              Kapso API key
            </label>
            <input id="kapso_api_key" name="kapso_api_key" type="password" placeholder="kapso_…" className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="kapso_project_id">
              Kapso project id
            </label>
            <input id="kapso_project_id" name="kapso_project_id" placeholder="proj_…" className={inputCls} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <label className={labelCls} htmlFor="whatsapp_phone_number_id">
              WhatsApp phone number id
            </label>
            <input id="whatsapp_phone_number_id" name="whatsapp_phone_number_id" className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="currency">
              Moneda
            </label>
            <input id="currency" name="currency" defaultValue="PEN" className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="timezone">
              Zona horaria
            </label>
            <input id="timezone" name="timezone" defaultValue="America/Lima" className={inputCls} />
          </div>
        </div>
      </fieldset>

      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.warnings?.map((w, i) => (
        <p key={i} className="text-sm text-amber-600">
          ⚠ {w}
        </p>
      ))}

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? "Conectando…" : "Conectar tienda"}
      </button>
    </form>
  );
}
