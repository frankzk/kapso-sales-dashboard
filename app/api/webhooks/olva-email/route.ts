import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { ingestOlvaEmailLabel, pdfText } from "@/lib/olva/email-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// El rótulo de Olva que llega por correo (MOM §12, «Cotejar Olva»). Lo manda
// un escenario de Make que vigila el buzón donde Olva escribe al registrar un
// envío (notificaciones@olva.com.pe) y saca el PDF adjunto:
//
//   POST /api/webhooks/olva-email   cabecera x-olva-email-secret: <secreto>
//   { "messageId": "...", "subject": "...", "receivedAt": "...",
//     "fileName": "rotulo-202600715289.pdf", "pdfBase64": "JVBERi0..." }
//
// Responde 200 también cuando el rótulo no se pudo leer o no casa con nada:
// para Make el correo está entregado, y lo que pasó queda en la tabla
// `olva_email_labels`. Solo un secreto malo o un cuerpo roto son error.

const MAX_PDF_BYTES = 2 * 1024 * 1024;

function secretEquals(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const secret = env.olvaEmailWebhookSecret();
  const given = req.headers.get("x-olva-email-secret") ?? req.nextUrl.searchParams.get("secret");
  if (!secretEquals(given, secret)) return new NextResponse("unauthorized", { status: 401 });

  let body: { messageId?: unknown; subject?: unknown; receivedAt?: unknown; fileName?: unknown; pdfBase64?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "cuerpo no es JSON" }, { status: 400 });
  }
  const messageId = typeof body.messageId === "string" ? body.messageId.trim() : "";
  const b64 = typeof body.pdfBase64 === "string" ? body.pdfBase64.trim() : "";
  if (!messageId || !b64) return NextResponse.json({ ok: false, error: "faltan messageId o pdfBase64" }, { status: 400 });

  const bytes = Buffer.from(b64, "base64");
  if (!bytes.length || bytes.length > MAX_PDF_BYTES) {
    return NextResponse.json({ ok: false, error: "el PDF está vacío o es demasiado grande" }, { status: 400 });
  }

  let text = "";
  try {
    text = await pdfText(new Uint8Array(bytes));
  } catch (e) {
    text = "";
    console.error("[olva-email] no se pudo leer el PDF", e);
  }

  const result = await ingestOlvaEmailLabel(createAdminSupabase(), {
    messageId,
    fileName: typeof body.fileName === "string" ? body.fileName : "",
    receivedAt: typeof body.receivedAt === "string" && body.receivedAt ? body.receivedAt : null,
    subject: typeof body.subject === "string" ? body.subject : null,
    text,
  });
  return NextResponse.json({ ok: true, ...result });
}
