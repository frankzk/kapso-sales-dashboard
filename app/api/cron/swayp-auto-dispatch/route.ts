import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { internalAuthorized } from "@/lib/voice-recovery-server";
import { runAutoDispatch } from "@/lib/swayp-auto-server";
import type { AutoSettings } from "@/lib/swayp-auto-policy";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
export async function GET(req:NextRequest) {
  if (!internalAuthorized(req)) return NextResponse.json({error:"unauthorized"},{status:401});
  // Previews must never issue production shipments, even if credentials were copied.
  if (process.env.VERCEL_ENV !== "production") return NextResponse.json({skipped:"not_production"});
  const admin=createAdminSupabase(), dry=req.nextUrl.searchParams.get("dry")==="1";
  const {data,error}=await admin.from("swayp_auto_settings").select("*").eq("enabled",true);
  if (error) return NextResponse.json({error:error.message},{status:500});
  const reports=[];
  for (const settings of (data??[]) as AutoSettings[]) reports.push(await runAutoDispatch(admin,settings,dry));
  return NextResponse.json({reports},{status:reports.some(x=>x.error)?502:200});
}
