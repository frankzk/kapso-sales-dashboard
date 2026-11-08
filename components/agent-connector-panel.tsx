"use client";

// Automatizaciones › Conector de IA (MOM §42): crear un token para un agente
// (Grok Bot), verlo UNA vez, listar los que hay con su último uso, cambiarle
// las herramientas y revocarlos; el interruptor de lo que el agente puede hacer
// y lo que hizo (§42.9). Arriba, cómo se conecta Grok. Ningún token llega aquí salvo el recién creado,
// en la respuesta de la acción: Kapta guarda solo su sha256.

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton } from "@/components/ops-ui";
import { CARD, CardHeader, CodeLine, HELP, ROW } from "@/components/settings-ui";
import { IconCopy } from "@/components/icons";
import { copyLabel, useCopyToClipboard } from "@/components/copy-button";
import {
  createAgentToken,
  revokeAgentToken,
  updateAgentTokenScopes,
  type AgentTokenFormState,
} from "@/app/dashboard/automatizaciones/conector/actions";
import { AgentActionsCard } from "@/components/agent-actions-card";
import type { AgentConnectorOrg, AgentTokenView } from "@/lib/agent-tokens-access";
import { StorePoliciesCard } from "@/components/store-policies-card";

const initial: AgentTokenFormState = {};

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

function Result({ state }: { state: AgentTokenFormState }) {
  if (!state.error && !state.notice) return null;
  return (
    <Banner tone={state.error ? "crit" : "ok"} role={state.error ? "alert" : "status"}>
      <p className="whitespace-pre-line break-words">{state.error ?? state.notice}</p>
    </Banner>
  );
}

interface ScopeOption {
  key: string;
  label: string;
  write: boolean;
}

function ScopeCheckbox({ scope, defaultChecked }: { scope: ScopeOption; defaultChecked: boolean }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm text-ink-700">
      <input type="checkbox" name="scopes" value={scope.key} defaultChecked={defaultChecked} />
      {scope.label}
      {scope.write && <Badge tone="warn">Hace cambios</Badge>}
    </label>
  );
}

function CreateTokenForm({ org, scopes }: { org: AgentConnectorOrg; scopes: ScopeOption[] }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(createAgentToken, initial);
  const { state: copied, copy } = useCopyToClipboard();
  useEffect(() => {
    if (state.token) router.refresh();
  }, [state, router]);
  return (
    <form action={action} className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title="Crear token"
        description="Un token por agente. Ve solo las tiendas que marques (y que tú ves) y usa solo las herramientas marcadas."
      />
      <input type="hidden" name="org_id" value={org.id} />
      <div className={cn(ROW, "space-y-4")}>
        <label className="block text-[13px] font-medium text-ink-700">
          Nombre
          <input
            name="label"
            required
            maxLength={80}
            defaultValue="Grok Bot · atención de pedidos"
            className={cn(FIELD, "mt-1.5 max-w-md")}
          />
        </label>
        <fieldset>
          <legend className="text-[13px] font-medium text-ink-700">Tiendas</legend>
          <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-2">
            {org.stores.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-sm text-ink-700">
                <input type="checkbox" name="store_ids" value={s.id} defaultChecked />
                {s.name}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-[13px] font-medium text-ink-700">Herramientas</legend>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {scopes.map((s) => (
              <ScopeCheckbox key={s.key} scope={s} defaultChecked={!s.write} />
            ))}
          </div>
          <p className={cn(HELP, "mt-2")}>
            Las de lectura no cambian nada. Las que hacen cambios siguen el interruptor de «Lo que puede hacer el agente» y los
            permisos de quien crea el token. Ninguna cambia estados ni anula guías.
          </p>
        </fieldset>
        <Result state={state} />
        {state.token && (
          <div className="space-y-2">
            <p className={HELP}>
              <strong>Tu token</strong> (se muestra una sola vez):
            </p>
            <div className="flex flex-wrap items-stretch gap-2">
              <CodeLine>{state.token}</CodeLine>
              <OpsButton type="button" onClick={() => copy(state.token!)} className="h-auto min-h-9">
                <IconCopy />
                {copyLabel(copied)}
              </OpsButton>
            </div>
          </div>
        )}
        <OpsButton type="submit" variant="primary" disabled={pending}>
          {pending ? "Creando…" : "Crear token"}
        </OpsButton>
      </div>
    </form>
  );
}

function TokenScopesForm({ orgId, token, scopes, onDone }: { orgId: string; token: AgentTokenView; scopes: ScopeOption[]; onDone: () => void }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(updateAgentTokenScopes, initial);
  const handled = useRef<AgentTokenFormState | null>(null);
  useEffect(() => {
    if (state.notice && !state.error && handled.current !== state) {
      handled.current = state;
      router.refresh();
      onDone();
    }
  }, [state, router, onDone]);
  return (
    <form action={action} className="space-y-2 rounded-md bg-ink-50 p-3">
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="token_id" value={token.id} />
      <div className="grid gap-2 sm:grid-cols-2">
        {scopes.map((s) => (
          <ScopeCheckbox key={s.key} scope={s} defaultChecked={token.scopes.includes(s.key)} />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <OpsButton type="submit" variant="primary" disabled={pending}>
          {pending ? "Guardando…" : "Guardar herramientas"}
        </OpsButton>
        <OpsButton type="button" onClick={onDone}>
          Cancelar
        </OpsButton>
      </div>
      <Result state={state} />
    </form>
  );
}

function TokenRow({ orgId, token, scopes }: { orgId: string; token: AgentTokenView; scopes: ScopeOption[] }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(revokeAgentToken, initial);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (state.notice && !state.error) router.refresh();
  }, [state, router]);
  const labels = new Map(scopes.map((s) => [s.key, s.label]));
  return (
    <li className={cn(ROW, "space-y-2")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink-900">{token.label}</span>
        <code className="text-xs text-ink-500">{token.hint}…</code>
        {token.revokedAt ? <Badge tone="neutral">Revocado {when(token.revokedAt)}</Badge> : <Badge tone="ok">Activo</Badge>}
      </div>
      <p className={HELP}>
        {token.storeNames.join(", ")} · creado {when(token.createdAt)} · último uso{" "}
        {when(token.lastUsedAt)}
        {token.lastTool ? ` (${token.lastTool})` : ""} · {token.callsToday} llamada(s) en 24 h
      </p>
      <p className={HELP}>Herramientas: {token.scopes.map((k) => labels.get(k) ?? k).join(" · ") || "ninguna"}</p>
      {!token.revokedAt && editing && <TokenScopesForm orgId={orgId} token={token} scopes={scopes} onDone={() => setEditing(false)} />}
      {!token.revokedAt && (
        <form action={action} className="flex flex-wrap items-center gap-2">
          {!editing && !confirming && (
            <OpsButton type="button" onClick={() => setEditing(true)}>
              Cambiar herramientas
            </OpsButton>
          )}
          <input type="hidden" name="org_id" value={orgId} />
          <input type="hidden" name="token_id" value={token.id} />
          {confirming ? (
            <>
              <span className={HELP}>¿Revocar? El agente deja de entrar en el acto.</span>
              <OpsButton type="submit" variant="danger" disabled={pending}>
                {pending ? "Revocando…" : "Sí, revocar"}
              </OpsButton>
              <OpsButton type="button" onClick={() => setConfirming(false)}>
                Cancelar
              </OpsButton>
            </>
          ) : (
            <OpsButton type="button" onClick={() => setConfirming(true)}>
              Revocar
            </OpsButton>
          )}
        </form>
      )}
      <Result state={state} />
    </li>
  );
}

function HowToConnect({ endpointUrl }: { endpointUrl: string }) {
  const { state: copied, copy } = useCopyToClipboard();
  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader title="Cómo se conecta Grok" description="Servidor MCP por HTTP, sin estado: con OAuth (Kapta pide permiso) o con un token en la cabecera." />
      <div className={cn(ROW, "space-y-3")}>
        <div className="flex flex-wrap items-stretch gap-2">
          <CodeLine>{endpointUrl}</CodeLine>
          <OpsButton type="button" onClick={() => copy(endpointUrl)} className="h-auto min-h-9">
            <IconCopy />
            {copyLabel(copied)}
          </OpsButton>
        </div>
        <div className={cn(HELP, "space-y-2")}>
          <p>
            <strong>Grok Bot (sin copiar tokens):</strong> pídele que agregue el conector MCP con la dirección {endpointUrl}.
            Grok te abre Kapta para que elijas tiendas y herramientas y pulses «Permitir» (OAuth). La conexión aparece abajo
            como un token más, y se revoca igual.
          </p>
          <p>
            <strong>API de xAI o un cliente que acepte cabeceras:</strong> crea un token aquí abajo y, en <code>tools</code>, una herramienta <code>{'{"type": "mcp"}'}</code> con{" "}
            <code>server_url</code> = esta dirección, <code>server_label</code> = <code>kapta</code> y{" "}
            <code>authorization</code> = el token.
          </p>
          <p>
            Para leer: <code>buscar_pedidos</code>, <code>obtener_pedido</code>, <code>leer_conversacion</code> (Kapso y
            Chatby) y <code>consultar_politicas</code> (las que Kapta calcula y las políticas escritas de abajo). Para hacer:{" "}
            <code>agregar_nota</code>, <code>enviar_whatsapp</code> y <code>crear_guia_aliclik</code>; las dos últimas en dos
            pasos (vista previa y confirmación con código). Todas quedan registradas.
          </p>
        </div>
      </div>
    </div>
  );
}

export function AgentConnectorPanel({
  endpointUrl,
  orgs,
  scopes,
  today,
  policiesMissing,
  actionsMissing,
}: {
  endpointUrl: string;
  orgs: AgentConnectorOrg[];
  scopes: ScopeOption[];
  today: string;
  policiesMissing: boolean;
  actionsMissing: boolean;
}) {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <header className="space-y-1">
        <p className="text-sm text-ink-500">
          <Link href="/dashboard/automatizaciones" className="underline">
            Automatizaciones
          </Link>{" "}
          ›
        </p>
        <h1 className="text-xl font-semibold text-ink-900">Conector de IA</h1>
        <p className={HELP}>
          Un agente de IA (por ejemplo Grok Bot) consulta pedidos, conversaciones y políticas de Kapta con un token y, si se lo
          permites, deja notas, le escribe a la clienta y crea guías de Aliclik. El token ve y hace solo lo que puede quien lo
          creó, y se revoca en un clic. Abajo, las políticas que escribe cada tienda.
        </p>
      </header>
      <HowToConnect endpointUrl={endpointUrl} />
      {orgs.map((org) => (
        <section key={org.id} className="space-y-3">
          {orgs.length > 1 && <h2 className="text-base font-semibold text-ink-900">{org.name}</h2>}
          <CreateTokenForm org={org} scopes={scopes} />
          <div className={cn(CARD, "divide-y divide-line")}>
            <CardHeader title="Tokens" description="Los activos y los revocados, del más nuevo al más viejo." />
            {org.tokens.length ? (
              <ul className="divide-y divide-line">
                {org.tokens.map((t) => (
                  <TokenRow key={t.id} orgId={org.id} token={t} scopes={scopes} />
                ))}
              </ul>
            ) : (
              <p className={cn(ROW, HELP)}>Todavía no hay tokens.</p>
            )}
          </div>
          <AgentActionsCard org={org} missing={actionsMissing} />
          <StorePoliciesCard org={org} today={today} missing={policiesMissing} />
        </section>
      ))}
    </div>
  );
}
