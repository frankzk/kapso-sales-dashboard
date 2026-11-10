// Una foto de constancia de un comentario del pedido (lib/order-comment-photos.ts).
//   GET /api/pedidos/<pedido>/comentario-foto?path=<ruta>
//
// El bucket es privado. Se entrega solo si quien pide puede LEER el pedido
// (RLS sobre `order_master`, como la ficha) y la ruta es de ese pedido.

import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { ORDER_COMMENT_PHOTO_BUCKET, isOrderCommentPhotoPath } from "@/lib/order-comment-photos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "No encontramos esa foto." }, { status: 404 });

export async function GET(req: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params;
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "No autenticado." }, { status: 401 });

  const { data: order } = await sb.from("order_master").select("store_id").eq("order_id", orderId).maybeSingle();
  const storeId = (order as { store_id?: string } | null)?.store_id;
  if (!storeId) return NOT_FOUND();

  const path = (req.nextUrl.searchParams.get("path") ?? "").trim();
  if (!isOrderCommentPhotoPath(path, storeId, orderId)) return NOT_FOUND();

  const { data, error } = await createAdminSupabase().storage.from(ORDER_COMMENT_PHOTO_BUCKET).download(path);
  if (error || !data) return NOT_FOUND();
  return new NextResponse(data, {
    headers: {
      "content-type": data.type || "image/jpeg",
      // La foto nunca cambia (la ruta lleva hora y azar): se guarda en el navegador.
      "cache-control": "private, max-age=86400, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
