import { NextResponse, type NextRequest } from "next/server";
import sharp from "sharp";
import { createAdminSupabase } from "@/lib/db";

export const runtime = "nodejs";

// La foto del producto para la cabecera de una plantilla de WhatsApp (0233,
// prueba de imagen en carritos abandonados). Meta descarga la imagen del
// `link` al enviar y solo acepta JPG o PNG; el 45 % de las fotos de catálogo
// de Shopify son WebP. Esta ruta la sirve siempre en JPG.
//
// Recibe la tienda y el producto, no una URL: así no es un proxy abierto y
// solo entrega fotos que ya están en `shopify_product_images`, que son las
// mismas fotos públicas del catálogo.
//
//   GET /api/wa-image/<storeId>/<productId>.jpg

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE = /^(\d{1,20})\.jpg$/;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ storeId: string; file: string }> }) {
  const { storeId, file } = await ctx.params;
  const productId = FILE.exec(file)?.[1];
  if (!UUID.test(storeId) || !productId) return new NextResponse("not found", { status: 404 });

  const { data } = await createAdminSupabase()
    .from("shopify_product_images")
    .select("image_url")
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .maybeSingle();
  const source = (data as { image_url?: string | null } | null)?.image_url;
  if (!source || !/^https:\/\/cdn\.shopify\.com\//.test(source)) return new NextResponse("not found", { status: 404 });

  try {
    const res = await fetch(source, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return new NextResponse("upstream", { status: 502 });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) return new NextResponse("upstream", { status: 502 });
    // 800 px de ancho basta para la cabecera; fondo blanco para los PNG
    // transparentes, que en JPG saldrían negros.
    const jpg = await sharp(bytes, { animated: false })
      .rotate()
      .resize({ width: 800, withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    return new NextResponse(new Uint8Array(jpg), {
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(jpg.length),
        "cache-control": "public, max-age=86400, s-maxage=604800",
      },
    });
  } catch (e) {
    console.error("[wa-image] no se pudo convertir la foto", storeId, productId, e);
    return new NextResponse("upstream", { status: 502 });
  }
}
