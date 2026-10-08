import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/access";
import { getMasterPermissions } from "@/lib/permissions-access";
import { applyNotebookImport } from "@/lib/notebook-apply";
import { cleanDecisions } from "@/lib/notebook-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cada parada recalcula el Master de su pedido; una hoja de 50 filas tarda.
export const maxDuration = 120;

/**
 * Aplica la hoja revisada (MOM §29.7).
 *   POST /api/courier/notebook/apply — JSON: { importId, decisions: [{ index, action, outcome, stopId? }] }
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });
  const permissions = await getMasterPermissions();
  if (!permissions.can("routes.manage")) {
    return NextResponse.json({ error: "Tu rol no arma rutas: la hoja la carga quien liquida en Grupo GF Courier." }, { status: 403 });
  }
  let body: { importId?: unknown; decisions?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido." }, { status: 400 });
  }
  const importId = typeof body.importId === "string" ? body.importId.trim() : "";
  if (!importId) return NextResponse.json({ error: "Falta la hoja." }, { status: 400 });
  const res = await applyNotebookImport(importId, cleanDecisions(body.decisions), user.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ ok: true, result: res.result });
}
