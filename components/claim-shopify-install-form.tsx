"use client";

import { useActionState } from "react";
import {
  claimShopifyInstall,
  type ClaimInstallState,
} from "@/app/dashboard/conectar-shopify/actions";

const initial: ClaimInstallState = {};

const inputCls =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
const labelCls = "block text-sm font-medium text-slate-700";

export function ClaimShopifyInstallForm({
  orgs,
  defaultName,
}: {
  orgs: { id: string; name: string }[];
  defaultName: string;
}) {
  const [state, action, pending] = useActionState(claimShopifyInstall, initial);
  return (
    <form action={action} className="max-w-md space-y-4">
      <div>
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
        <input id="name" name="name" required defaultValue={defaultName} className={inputCls} />
      </div>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
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
