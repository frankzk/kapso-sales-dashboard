import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { internalAuthorized } from "@/lib/voice-recovery-server";
import { processWooSaleReturn } from "@/lib/woo-sale-return-server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
export async function GET(req: NextRequest) {
  if (!internalAuthorized(req)) return new NextResponse("unauthorized",{status:401});
  const admin=createAdminSupabase();
  const results=[];
  for (let i=0;i<2;i++) {
    const result=await processWooSaleReturn(admin);
    results.push(result.state);
    if (result.state==="skipped") break;
  }
  console.log("[woo-sale-returns]",JSON.stringify({results}));
  return NextResponse.json({ok:!results.includes("pending"),results},{status:results.includes("pending")?502:200});
}
