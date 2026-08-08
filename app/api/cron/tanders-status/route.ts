import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { sweepTandersStatus } from "@/lib/tanders/status-sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Estado de las guías Tanders leído de su propia API. La lógica vive en
// lib/tanders/status-sweep.ts; esto solo autentica.

function secretEquals(got: string | null, want: string): boolean {
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
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
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const report = await sweepTandersStatus(createAdminSupabase());
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "falló el barrido" },
      { status: 500 },
    );
  }
}
