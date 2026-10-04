import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { ingestYapeStatement } from "@/lib/yape-statement/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// El reporte de movimientos de Yape Empresa que llega por correo (MOM §16.2).
// Lo manda un escenario de Make que vigila el buzón donde Yape escribe
// (notificaciones@yape.pe, «Te compartimos tus movimientos») y saca el Excel
// adjunto:
//
//   POST /api/webhooks/yape-movements   cabecera x-yape-movements-secret: <secreto>
//   multipart/form-data: messageId, subject, receivedAt, fileName y `file`
//   (el .xlsx). O JSON con los mismos campos y `fileBase64`.
//
// Con `?simulacro=1` calcula todo —qué validaría— y no escribe nada: es como
// se prueba un reporte a mano antes de dejar a Make mandarlos.
//
// Responde 200 también cuando el reporte no trae nada que cruzar: para Make el
// correo está entregado, y lo que pasó queda en `yape_statement_imports`. Solo
// un secreto malo o un cuerpo roto son error.

const MAX_XLSX_BYTES = 8 * 1024 * 1024;
/** Corte por reloj, por debajo de `maxDuration`: el corte tiene que ser nuestro. */
const BUDGET_MS = 240_000;

function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const secret = env.yapeMovementsWebhookSecret();
  const given = req.headers.get("x-yape-movements-secret") ?? req.nextUrl.searchParams.get("secret");
  if (!secretEquals(given, secret)) return new NextResponse("unauthorized", { status: 401 });
  const dryRun = req.nextUrl.searchParams.get("simulacro") === "1";

  let messageId = "";
  let subject: string | null = null;
  let receivedAt: string | null = null;
  let fileName = "";
  let bytes: Buffer;
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("multipart/form-data")) {
      const form = await req.formData();
      const str = (k: string) => {
        const v = form.get(k);
        return typeof v === "string" ? v.trim() : "";
      };
      messageId = str("messageId");
      subject = str("subject") || null;
      receivedAt = str("receivedAt") || null;
      fileName = str("fileName");
      const file = form.get("file");
      bytes = file && typeof file !== "string" ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
      if (!fileName && file && typeof file !== "string") fileName = file.name ?? "";
    } else {
      const body = (await req.json()) as Record<string, unknown>;
      const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");
      messageId = str("messageId");
      subject = str("subject") || null;
      receivedAt = str("receivedAt") || null;
      fileName = str("fileName");
      bytes = Buffer.from(str("fileBase64"), "base64");
    }
  } catch {
    return NextResponse.json({ ok: false, error: "cuerpo ilegible" }, { status: 400 });
  }
  if (!messageId) return NextResponse.json({ ok: false, error: "falta messageId" }, { status: 400 });
  if (!bytes.length || bytes.length > MAX_XLSX_BYTES) {
    return NextResponse.json({ ok: false, error: "el Excel está vacío o es demasiado grande" }, { status: 400 });
  }
  // Un .xlsx es un ZIP. Cualquier otro adjunto (el logo de la firma, un PDF) no
  // es asunto de este endpoint.
  if (bytes.subarray(0, 4).toString("latin1") !== "PK\u0003\u0004") {
    return NextResponse.json({ ok: true, outcome: "ignorado", note: "el adjunto no es un Excel" });
  }

  try {
    const result = await ingestYapeStatement(createAdminSupabase(), {
      messageId,
      fileName,
      receivedAt,
      subject,
      bytes,
      dryRun,
      budgetMs: BUDGET_MS,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("[yape-movements] no se pudo procesar el reporte", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "no se pudo procesar el reporte" },
      { status: 500 },
    );
  }
}
