import { NextResponse } from "next/server";

// Public health endpoint (no secrets) for uptime checks and post-deploy smoke.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "kapso-sales-dashboard",
    time: new Date().toISOString(),
  });
}
