import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { orgsWithPermission } from "@/lib/permissions-access";
import { AGENT_SCOPES } from "@/lib/agent-auth";
import {
  OAUTH_MIGRATION_MISSING,
  OAUTH_SCOPES,
  clientRedirect,
  isOAuthMigrationMissing,
  parseAuthorizeRequest,
  redirectHost,
} from "@/lib/agent-oauth";
import { OAuthConsentForm, type ConsentStore } from "@/components/oauth-consent-form";

// `/oauth/authorize` (MOM §42.8): donde una persona le da permiso a un agente de
// IA (Grok Bot) para entrar a Kapta, sin copiar tokens. Sin sesión, el proxy
// manda al login y vuelve aquí después. Con `automations.manage`, como crear un
// token a mano.

export const dynamic = "force-dynamic";
export const metadata = { title: "Conectar un agente de IA · Kapta" };

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-wash p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-control ring-1 ring-line">{children}</div>
    </main>
  );
}

function Problem({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Shell>
      <h1 className="text-lg font-semibold text-ink-900">{title}</h1>
      <p className="mt-2 text-sm text-ink-600">{children}</p>
    </Shell>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") params[k] = v;

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminSupabase();
  const { data: clientRow, error: clientError } = await admin
    .from("agent_oauth_clients")
    .select("client_id, client_name, redirect_uris")
    .eq("client_id", params.client_id ?? "")
    .maybeSingle();
  if (clientError) {
    return <Problem title="No se pudo conectar">{isOAuthMigrationMissing(clientError) ? OAUTH_MIGRATION_MISSING : "No se pudo leer el agente. Reintenta."}</Problem>;
  }
  const client = clientRow as { client_name: string; redirect_uris: string[] } | null;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const origin = `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`;
  const parsed = parseAuthorizeRequest(params, client?.redirect_uris ?? null, origin);
  if (!parsed.ok) {
    if (parsed.fatal) return <Problem title="No se pudo conectar">{parsed.message}</Problem>;
    redirect(clientRedirect(parsed.redirectUri, { error: parsed.error, error_description: parsed.description, state: parsed.state }));
  }

  const memberships = await orgsWithPermission("automations.manage");
  if (!memberships.length) {
    return (
      <Problem title="Sin permiso">
        Conectar agentes de IA a Kapta es del dueño, o de quien él autorice en Equipo («Automatizaciones»).
      </Problem>
    );
  }
  const orgIds = [...new Set(memberships.map((m) => m.org_id))];
  const [{ data: storeRows }, { data: orgRows }] = await Promise.all([
    sb.from("stores").select("id, name, org_id").in("org_id", orgIds).order("name"),
    admin.from("organizations").select("id, name").in("id", orgIds),
  ]);
  const orgName = new Map(((orgRows ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));
  const stores: ConsentStore[] = ((storeRows ?? []) as { id: string; name: string; org_id: string }[]).map((s) => ({
    id: s.id,
    name: s.name,
    orgName: orgIds.length > 1 ? (orgName.get(s.org_id) ?? null) : null,
  }));
  if (!stores.length) return <Problem title="Sin tiendas">No ves ninguna tienda en las organizaciones donde puedes conectar agentes.</Problem>;

  const request = parsed.request;
  return (
    <Shell>
      <OAuthConsentForm
        clientName={client!.client_name}
        redirectHost={redirectHost(request.redirectUri)}
        params={Object.fromEntries(
          Object.entries({
            response_type: "code",
            client_id: request.clientId,
            redirect_uri: request.redirectUri,
            code_challenge: request.codeChallenge,
            code_challenge_method: "S256",
            state: request.state ?? "",
            scope: params.scope ?? "",
            resource: params.resource ?? "",
          }).filter(([, v]) => v),
        )}
        stores={stores}
        scopes={OAUTH_SCOPES.map((key) => ({ key, label: AGENT_SCOPES[key].label, write: AGENT_SCOPES[key].write, checked: request.requestedScopes.includes(key) }))}
        defaultLabel={`${client!.client_name} (OAuth)`.slice(0, 80)}
      />
    </Shell>
  );
}
