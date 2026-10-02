import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { loadOlvaPortalAccounts, runOlvaCotejo } from "@/lib/olva/portal-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// «Cotejar Olva» automático (MOM §12): cada dos horas, de 7 a 19 h de Lima,
// entra al portal de clientes de Olva con la cuenta de cada organización, trae
// los envíos de los últimos 7 días y les pone el tracking a las salidas que no
// lo tienen, solo cuando no hay duda. El rastreo y los avisos a la clienta los
// hace después, como siempre, /api/cron/olva-reconcile.
//
// No más seguido: es un inicio de sesión en el portal de un courier, detrás de
// Cloudflare. Un acceso cada dos horas es lo que haría una persona; uno cada
// media hora es lo que Cloudflare aprende a bloquear.

function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorized(req: NextRequest): boolean {
  const secret = env.cronSecret();
  const bearer = req.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && secretEquals(bearer.slice(7), secret)) return true;
  return secretEquals(req.nextUrl.searchParams.get("secret"), secret);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return new NextResponse("unauthorized", { status: 401 });
  const admin = createAdminSupabase();
  const accounts = await loadOlvaPortalAccounts(admin);
  if (!accounts.length) return NextResponse.json({ ok: true, skipped: "ninguna tienda tiene la cuenta del portal de Olva" });

  const results = [];
  for (const account of accounts) {
    const r = await runOlvaCotejo(admin, { account, source: "cron", actor: null });
    results.push({ orgId: account.orgId, ...r });
  }
  return NextResponse.json({ ok: results.every((r) => r.ok), results });
}
