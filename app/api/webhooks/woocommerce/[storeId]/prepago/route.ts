import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { PREPAY_MAX_BODY_BYTES, PREPAY_SIGNATURE_HEADER, PREPAY_TIMESTAMP_HEADER, handlePrepayQuery } from "@/lib/prepay-woo";

// «¿Este celular paga por adelantado?» (MOM §41.5): la consulta del mu-plugin
// de WordPress (docs/kapta/wordpress/kapta-prepago.php) y del formulario de
// COD Core (docs/kapta/cod-core-prepago.md). Contesta `{ prepay_required }` y
// nada más. La firma y el sello, en lib/prepay-woo.ts.

// Necesita crypto de Node (HMAC) y el cliente service-role.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > PREPAY_MAX_BODY_BYTES) {
    return NextResponse.json({ error: "El cuerpo es demasiado grande." }, { status: 413 });
  }
  const rawBody = await req.text(); // crudo: la firma es sobre estos bytes
  const result = await handlePrepayQuery(createAdminSupabase(), {
    storeId,
    rawBody,
    signature: req.headers.get(PREPAY_SIGNATURE_HEADER),
    timestamp: req.headers.get(PREPAY_TIMESTAMP_HEADER),
  });
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
