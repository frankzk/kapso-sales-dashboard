import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminSupabase } from "@/lib/db";
import { env } from "@/lib/env";
import { ingestOlvaEmailLabels, pdfText } from "@/lib/olva/email-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// El rótulo de Olva que llega por correo (MOM §12, «Cotejar Olva»). Lo manda
// un escenario de Make que vigila el buzón donde Olva escribe al registrar un
// envío (notificaciones@olva.com.pe) y saca el PDF adjunto:
//
//   POST /api/webhooks/olva-email   cabecera x-olva-email-secret: <secreto>
//   multipart/form-data: messageId, subject, receivedAt, fileName y `file`
//   (el PDF). O JSON con los mismos campos y `pdfBase64`.
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

  // Make lo manda como multipart (el PDF como archivo, sin escapar nada); se
  // acepta también JSON con el PDF en base64, para pruebas a mano.
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
      bytes = Buffer.from(str("pdfBase64"), "base64");
    }
  } catch {
    return NextResponse.json({ ok: false, error: "cuerpo ilegible" }, { status: 400 });
  }
  if (!messageId) return NextResponse.json({ ok: false, error: "falta messageId" }, { status: 400 });
  if (!bytes.length || bytes.length > MAX_PDF_BYTES) {
    return NextResponse.json({ ok: false, error: "el PDF está vacío o es demasiado grande" }, { status: 400 });
  }
  // Solo el rótulo: Olva adjunta un PDF por correo, y cualquier otro adjunto
  // (una imagen de la firma, por ejemplo) no es asunto de este endpoint.
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return NextResponse.json({ ok: true, outcome: "ignorado", note: "el adjunto no es un PDF" });
  }

  let text = "";
  try {
    text = await pdfText(new Uint8Array(bytes));
  } catch (e) {
    text = "";
    console.error("[olva-email] no se pudo leer el PDF", e);
  }

  // Un rótulo por envío del registro: el PDF puede traer varios (0232).
  const labels = await ingestOlvaEmailLabels(createAdminSupabase(), { messageId, fileName, receivedAt, subject, text });
  return NextResponse.json({ ok: true, ...labels[0], labels });
}
