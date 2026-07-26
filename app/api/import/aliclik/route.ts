import { type NextRequest } from "next/server";
import { POST as importCourier } from "@/app/api/import/courier/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Ruta histórica de la carga del Excel de Aliclik. Se conserva porque hay
// enlaces y la pantalla de Repro Provincia la usaba; ahora delega en la ruta
// genérica (§6) forzando el courier, así que gana lo que ganó esa: el archivo
// original se conserva, el lote registra sus metadatos y el Master se refresca.
//
//   POST /api/import/aliclik   (multipart: file=<reporte>, storeId=<tienda>)
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  if (!form) {
    return Response.json({ error: "Cuerpo inválido (se esperaba multipart)." }, { status: 400 });
  }
  form.set("courier", "aliclik");

  // Reconstruye la petición con el courier fijado; `formData()` ya consumió el
  // cuerpo original, así que no se puede reenviar `req` tal cual.
  const forwarded = new Request(req.url, {
    method: "POST",
    headers: { cookie: req.headers.get("cookie") ?? "" },
    body: form,
  }) as NextRequest;

  return importCourier(forwarded);
}
