import { NextResponse, type NextRequest } from "next/server";
import { COD_CORE_SIGNATURE_HEADER } from "@/lib/cod-core-abandoned";
import { codCoreHttpStatus, processCodCoreAbandoned, type CodCoreResult } from "@/lib/cod-core-abandoned-ingest";
import { createAdminSupabase } from "@/lib/db";

// Los formularios abandonados de COD Core (MOM §38.12): cada uno que pasa a
// «Formularios abandonados» o a «Recuperados». El contrato está en
// docs/kapta/cod-core-abandonados.md; las respuestas, en
// lib/cod-core-abandoned-ingest.ts.

// Necesita crypto de Node (HMAC) y el cliente service-role.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const rawBody = await req.text(); // crudo: la firma es sobre estos bytes

  let result: CodCoreResult;
  try {
    result = await processCodCoreAbandoned(createAdminSupabase(), {
      storeId,
      rawBody,
      signature: req.headers.get(COD_CORE_SIGNATURE_HEADER),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "error interno";
    console.error(`[cod-core] ${JSON.stringify({ storeId, error: message })}`);
    result = { status: "error", message: "Error interno: reenvíalo." };
  }

  const status = codCoreHttpStatus(result);
  if (result.status === "ok") {
    return NextResponse.json({ ok: true, evento: result.event, id: result.formId, ...(result.message ? { message: result.message } : {}) }, { status });
  }
  if (result.status === "unknown_store") return NextResponse.json({ ok: false, error: "tienda desconocida" }, { status });
  return NextResponse.json({ ok: false, error: result.message }, { status });
}
