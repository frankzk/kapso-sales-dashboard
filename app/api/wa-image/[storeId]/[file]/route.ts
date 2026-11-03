import { NextResponse, type NextRequest } from "next/server";
import { createAdminSupabase } from "@/lib/db";
import { isShopifyCdnUrl, productPhotoPath, readStoredPhoto } from "@/lib/product-photos";
import { fetchProductPhotoJpeg } from "@/lib/product-photos-copy";

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
// PRIMERO LA COPIA GUARDADA (MOM §39). El cron /api/cron/product-photos copia
// cada foto a Storage, ya convertida, mientras el CDN de Shopify responde: el
// 28-10-2026 Shopify cierra Kenku y Aurela y su CDN dejará de servirlas. Solo
// si no hay copia para la URL actual se baja en vivo, como siempre.
//
//   GET /api/wa-image/<storeId>/<productId>.jpg

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE = /^(\d{1,20})\.jpg$/;

function jpeg(bytes: Uint8Array): NextResponse {
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(bytes.byteLength),
      "cache-control": "public, max-age=86400, s-maxage=604800",
    },
  });
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ storeId: string; file: string }> }) {
  const params = await ctx.params;
  const productId = FILE.exec(params.file)?.[1];
  if (!UUID.test(params.storeId) || !productId) return new NextResponse("not found", { status: 404 });
  // En minúsculas, como lo escribe la base: la carpeta de la copia en Storage
  // distingue mayúsculas, y la misma tienda no puede tener dos carpetas.
  const storeId = params.storeId.toLowerCase();

  const admin = createAdminSupabase();
  const { data } = await admin
    .from("shopify_product_images")
    .select("image_url")
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .maybeSingle();
  const source = (data as { image_url?: string | null } | null)?.image_url;
  if (!isShopifyCdnUrl(source)) return new NextResponse("not found", { status: 404 });

  // La copia de ESTA URL: si la foto cambió en Shopify, la ruta es otra y la
  // copia vieja no se sirve.
  const stored = await readStoredPhoto(admin, productPhotoPath(storeId, productId, source));
  if (stored) return jpeg(stored);

  // 800 px de ancho basta para la cabecera; fondo blanco para los PNG
  // transparentes, que en JPG saldrían negros (`toWhatsappJpeg`).
  const got = await fetchProductPhotoJpeg(source);
  if (!got.ok) {
    if (got.reason === "red" || got.reason === "conversion") {
      console.error("[wa-image] no se pudo convertir la foto", storeId, productId, got.error);
    }
    return new NextResponse("upstream", { status: 502 });
  }
  return jpeg(got.jpg);
}
