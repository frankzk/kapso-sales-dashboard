import { EmptyState } from "@/components/ui";
import { AgentConnectorPanel } from "@/components/agent-connector-panel";
import { loadAgentConnector } from "@/lib/agent-tokens-access";
import { AGENT_SCOPES } from "@/lib/agent-auth";

// Automatizaciones › Conector de IA (MOM §42, 08-11-2026): los tokens con los que
// un agente (Grok Bot) consulta pedidos, conversaciones y políticas de Kapta por
// `POST /api/mcp`, y lo que puede hacer (notas, WhatsApp, guías; §42.9). Entra
// quien tiene `automations.manage`.

export const dynamic = "force-dynamic";

export default async function ConectorPage() {
  let data: Awaited<ReturnType<typeof loadAgentConnector>>;
  try {
    data = await loadAgentConnector();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return <EmptyState title="No pudimos cargar el conector">{`${message} Recarga la página.`}</EmptyState>;
  }
  if (data.denied) {
    return (
      <EmptyState title="Acceso restringido">
        Crear tokens para agentes de IA es del dueño, o de quien él autorice en Equipo («Automatizaciones»).
      </EmptyState>
    );
  }
  if (data.migrationMissing) {
    return (
      <EmptyState title="Falta la migración 0314">
        Hay que aplicar la migración 0314 (conector de IA) en la base antes de crear tokens. Hasta entonces /api/mcp contesta 503.
      </EmptyState>
    );
  }
  const scopes = Object.entries(AGENT_SCOPES).map(([key, s]) => ({ key, label: s.label, write: s.write }));
  return (
    <AgentConnectorPanel
      endpointUrl={data.endpointUrl}
      orgs={data.orgs}
      scopes={scopes}
      today={data.today}
      policiesMissing={data.policiesMissing}
      actionsMissing={data.actionsMissing}
    />
  );
}
