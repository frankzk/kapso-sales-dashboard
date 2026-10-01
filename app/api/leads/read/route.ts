import { z } from "zod";
import * as actions from "@/app/dashboard/leads/actions";
import { getAccessibleStores, getCurrentUser } from "@/lib/access";

export const dynamic = "force-dynamic";

const uuid = z.string().uuid();
const scope = z.array(uuid).max(100);
const lead = z.tuple([uuid]);
const schemas = {
  loadLeadCustomerHistory: lead,
  loadLeadDetail: lead,
  loadLeadsInsightsPanel: z.tuple([scope, z.string().min(1).max(100), z.number().int().nonnegative()]),
  pollLeadsQueue: z.tuple([scope]),
  searchLeads: z.tuple([scope, z.string().max(200)]),
  loadLeadsForAudience: z.tuple([scope, z.enum(["por_llamar", "handoff", "yape", "seguimientos", "ganados", "perdidos"])]),
  listLeadTemplates: lead,
  listQuickReplies: lead,
  loadLeadConversation: z.tuple([uuid, z.string().max(200).nullish(), z.boolean().optional()]),
  loadOrderDraft: lead,
  pollLeadState: lead,
  searchStoreProducts: z.tuple([uuid, z.string().max(200)]),
  listStoreVendedoras: lead,
  listYapeAlerts: z.tuple([]),
} as const;

const envelope = z.object({
  operation: z.enum(Object.keys(schemas) as [keyof typeof schemas, ...(keyof typeof schemas)[]]),
  args: z.array(z.unknown()),
}).strict();

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

/**
 * Independent HTTP transport for UI reads. Existing functions still enforce
 * lead/store access through RLS before privileged enrichment.
 * POST is intentional: history/status reconciliation and the Yape heartbeat
 * can perform maintenance writes. They must not be cached or prefetched.
 * Never dispatch arbitrary action names (especially send/claim/register).
 */
export async function POST(request: Request) {
  const requestStartedAt = performance.now();
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return json({ error: "Origen inválido." }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "Formato inválido." }, 415);
  if (Number(request.headers.get("content-length") ?? 0) > 16_384) return json({ error: "Solicitud demasiado grande." }, 413);
  const authStartedAt = performance.now();
  if (!await getCurrentUser()) return json({ error: "Sin sesión." }, 401);
  const authMs = Math.round(performance.now() - authStartedAt);

  const raw = await request.text();
  if (raw.length > 16_384) return json({ error: "Solicitud demasiado grande." }, 413);
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return json({ error: "Solicitud inválida." }, 400); }
  const parsed = envelope.safeParse(input);
  if (!parsed.success) return json({ error: "Solicitud inválida." }, 400);
  const { operation } = parsed.data;
  const params = schemas[operation].safeParse(parsed.data.args);
  if (!params.success) return json({ error: "Parámetros inválidos." }, 400);
  // This enrichment uses an admin client internally. Check the requested
  // store before handing it to the existing role check.
  if (operation === "listStoreVendedoras") {
    const stores = await getAccessibleStores();
    if (!stores.some((store) => store.id === params.data[0])) {
      return json({ error: "Sin acceso a esta tienda." }, 403);
    }
  }

  const startedAt = performance.now();
  try {
    // Explicit allowlist above plus validated tuples. A local server-side call
    // does not enter the browser's serialized Server Action queue.
    const handler = actions[operation] as (...args: never[]) => Promise<unknown>;
    const args = params.data.map((value) => value === null ? undefined : value);
    return json(await handler(...args as never[]));
  } catch {
    return json({ error: "No se pudo cargar la información." }, 500);
  } finally {
    // No phone numbers, lead ids, search text or customer content in telemetry.
    console.info(JSON.stringify({
      event: "leads.read", operation,
      durationMs: Math.round(performance.now() - startedAt),
      authMs, totalMs: Math.round(performance.now() - requestStartedAt),
    }));
  }
}

