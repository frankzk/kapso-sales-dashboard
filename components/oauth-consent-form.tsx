"use client";

// El permiso que da una persona a un agente de IA para entrar a Kapta (MOM
// §42.8): qué agente, adónde vuelve, qué tiendas y qué herramientas. «Permitir»
// crea un código de un solo uso y vuelve al agente; «Cancelar» vuelve sin nada.

import { useActionState } from "react";
import { Banner, FIELD, OpsButton } from "@/components/ops-ui";
import { cn } from "@/components/ui";
import { HELP } from "@/components/settings-ui";
import {
  approveAgentAuthorization,
  denyAgentAuthorization,
  type ConsentState,
} from "@/app/oauth/authorize/actions";

export interface ConsentStore {
  id: string;
  name: string;
  orgName: string | null;
}

export function OAuthConsentForm({
  clientName,
  redirectHost,
  params,
  stores,
  scopes,
  defaultLabel,
}: {
  clientName: string;
  redirectHost: string;
  params: Record<string, string>;
  stores: ConsentStore[];
  scopes: { key: string; label: string; checked: boolean }[];
  defaultLabel: string;
}) {
  const [approveState, approve, approving] = useActionState(approveAgentAuthorization, {} as ConsentState);
  const [denyState, deny, denying] = useActionState(denyAgentAuthorization, {} as ConsentState);
  const error = approveState.error ?? denyState.error;
  const busy = approving || denying;
  return (
    <form className="space-y-5">
      {Object.entries(params).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-ink-900">
          {clientName} quiere conectarse a Kapta
        </h1>
        <p className={HELP}>
          Podrá usar las herramientas que marques, en las tiendas que marques, con tus accesos de hoy. Vuelve a{" "}
          <strong>{redirectHost}</strong>. Lo revocas cuando quieras en Automatizaciones › Conector de IA.
        </p>
      </div>
      <label className="block text-[13px] font-medium text-ink-700">
        Nombre de la conexión
        <input name="label" required maxLength={80} defaultValue={defaultLabel} className={cn(FIELD, "mt-1.5")} />
      </label>
      <fieldset>
        <legend className="text-[13px] font-medium text-ink-700">Tiendas</legend>
        <div className="mt-1.5 space-y-1.5">
          {stores.map((s) => (
            <label key={s.id} className="flex items-center gap-2 text-sm text-ink-700">
              <input type="checkbox" name="store_ids" value={s.id} defaultChecked />
              {s.orgName ? `${s.orgName} · ${s.name}` : s.name}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-[13px] font-medium text-ink-700">Herramientas (solo lectura)</legend>
        <div className="mt-1.5 space-y-1.5">
          {scopes.map((s) => (
            <label key={s.key} className="flex items-center gap-2 text-sm text-ink-700">
              <input type="checkbox" name="scopes" value={s.key} defaultChecked={s.checked} />
              {s.label}
            </label>
          ))}
        </div>
      </fieldset>
      {error && (
        <Banner tone="crit" role="alert">
          {error}
        </Banner>
      )}
      <div className="flex flex-wrap gap-2">
        <OpsButton type="submit" variant="primary" formAction={approve} disabled={busy}>
          {approving ? "Conectando…" : "Permitir"}
        </OpsButton>
        <OpsButton type="submit" formAction={deny} disabled={busy} formNoValidate>
          {denying ? "Cancelando…" : "Cancelar"}
        </OpsButton>
      </div>
    </form>
  );
}
