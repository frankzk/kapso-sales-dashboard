import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createAdminSupabase } from "@/lib/db";
import { syncUrpiAutomatically, urpiAutoEnabled } from "@/lib/urpi-auto-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if ((process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") || !urpiAutoEnabled()) {
    return NextResponse.json({ ok: true, skipped: true });
  }
  try {
    const report = await syncUrpiAutomatically(createAdminSupabase());
    if (report.scanned) revalidatePath("/dashboard/urpi");
    return NextResponse.json({ ok: report.failed === 0, ...report }, { status: report.failed ? 503 : 200 });
  } catch {
    return NextResponse.json({ ok: false, error: "No se pudo ejecutar la lectura automática de Urpi." }, { status: 503 });
  }
}
