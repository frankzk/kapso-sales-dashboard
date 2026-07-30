import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";

// Sirve el comprobante de Yape que se subió con un pago.
//
// La imagen ya se guardaba —bucket PRIVADO `yape-vouchers`— pero solo la leía la
// visión, por dentro, para extraer el nº de operación. Nadie podía volver a
// verla: quien validaba un pago tenía que fiarse de los campos ya transcritos,
// que es justo lo que un comprobante sirve para contrastar.
//
// El bucket sigue privado y sin URLs firmadas al cliente: el archivo pasa por
// acá, detrás del login y de RLS. Descifrar no hace falta, pero sí el cliente
// admin para leer el bucket → Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "yape-vouchers";

/**
 * Solo imágenes, y solo las que el navegador no puede ejecutar. El archivo lo
 * subió un usuario y se sirve desde NUESTRO origen: dejar pasar un
 * `image/svg+xml` sería permitir ejecutar script en el dominio del panel. Lo que
 * no esté en la lista se descarga en vez de mostrarse.
 */
const INLINE_OK = /^image\/(png|jpeg|jpg|gif|webp|avif|heic|heif)$/;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ paymentId: string }> }) {
  const { paymentId } = await ctx.params;

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  // RLS decide: un pago de una tienda ajena sencillamente no aparece.
  const { data: payment } = await sb
    .from("order_payments")
    .select("id,file_path")
    .eq("id", paymentId)
    .maybeSingle();
  if (!payment) return new NextResponse("forbidden", { status: 403 });

  const path = (payment as { file_path: string | null }).file_path;
  if (!path) return new NextResponse("Este pago se registró sin comprobante.", { status: 404 });

  const admin = createAdminSupabase();
  const { data, error } = await admin.storage.from(BUCKET).download(path);
  if (error || !data) return new NextResponse("No se pudo leer el comprobante.", { status: 502 });

  const type = (data.type || "").split(";")[0]!.trim().toLowerCase();
  const safe = INLINE_OK.test(type);

  return new NextResponse(data.stream(), {
    status: 200,
    headers: {
      "content-type": safe ? type : "application/octet-stream",
      "x-content-type-options": "nosniff",
      "content-disposition": `${safe ? "inline" : "attachment"}; filename="comprobante-${paymentId}"`,
      // Privado: es el comprobante de un pedido concreto.
      "cache-control": "private, max-age=300",
    },
  });
}
