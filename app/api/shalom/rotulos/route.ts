// Rótulos compuestos de Shalom en lote, desde la barra del Master (01-10-2026).
//
// Lo mismo que «Rótulo ↗» del drawer (lib/shalom/rotulo-compose.ts) para varios
// pedidos a la vez, en un solo PDF de etiquetas de 100×150 mm. Por pedido se
// imprime su salida Shalom vigente creada por API
// (lib/labels/guia-combinada-select.ts); solo lee, no crea salidas.
//
// EL TIEMPO. Pedir una etiqueta a Shalom la primera vez cuesta ~45 s; después
// sale de la caché. Por eso se piden de a pocas en paralelo y la ruta tiene
// margen largo. La guía que falla no tumba el lote: se omite y se cuenta, y la
// barra lo dice — el drawer sigue sirviendo para reintentarla una por una.

import { NextResponse, type NextRequest } from "next/server";
import { PDFDocument } from "pdf-lib";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import type { StoreShalom } from "@/lib/shalom/session";
import { pickCombinadaOutputs, type CombinadaCandidate } from "@/lib/labels/guia-combinada-select";
import { SHALOM_ROTULO_COLUMNS, composeShalomRotulo, type ShalomRotuloRow } from "@/lib/shalom/rotulo-compose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Una tanda de agencia son decenas; más que esto no cabe en el tiempo de la ruta. */
const MAX_LABELS = 60;
/** De a cuántas se le piden a Shalom a la vez. */
const CONCURRENCY = 4;

function parseIds(raw: string | null): string[] {
  return Array.from(new Set((raw ?? "").split(",").map((v) => v.trim()).filter(Boolean)));
}

export async function GET(request: NextRequest) {
  const orderIds = parseIds(request.nextUrl.searchParams.get("orders"));
  if (!orderIds.length) return NextResponse.json({ error: "Indica los pedidos a imprimir." }, { status: 400 });
  if (orderIds.length > MAX_LABELS) {
    return NextResponse.json(
      { error: `Demasiados rótulos de Shalom de una vez (máximo ${MAX_LABELS}).` },
      { status: 400 },
    );
  }

  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return new NextResponse("unauthorized", { status: 401 });

  // Por RLS: un pedido de otra tienda no trae salidas y queda como omitido.
  const { data } = await sb
    .from("shipments")
    .select(`${SHALOM_ROTULO_COLUMNS},delivery_status`)
    .in("order_id", orderIds)
    .eq("courier", "shalom");
  const rows = (data ?? []) as unknown as (ShalomRotuloRow & { delivery_status: string })[];
  const picked = pickCombinadaOutputs(orderIds, rows as CombinadaCandidate[], "shalom");
  if (!picked.shipmentIds.length) {
    return NextResponse.json(
      { error: "Ninguno de esos pedidos tiene una guía de Shalom creada desde Kapta." },
      { status: 400 },
    );
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const admin = createAdminSupabase();
  const stores = new Map<string, Promise<StoreShalom | null>>();
  const pdfs: (Uint8Array | null)[] = new Array(picked.shipmentIds.length).fill(null);
  let failed = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, picked.shipmentIds.length) }, async () => {
      while (next < picked.shipmentIds.length) {
        const i = next++;
        const result = await composeShalomRotulo(sb, admin, byId.get(picked.shipmentIds[i]!)!, stores);
        if (result.ok) pdfs[i] = result.pdf;
        else failed += 1;
      }
    }),
  );

  const doc = await PDFDocument.create();
  for (const bytes of pdfs) {
    if (!bytes) continue;
    const src = await PDFDocument.load(bytes);
    for (const page of await doc.copyPages(src, src.getPageIndices())) doc.addPage(page);
  }
  if (!doc.getPageCount()) {
    return NextResponse.json(
      { error: "Shalom no devolvió ningún rótulo. Prueba uno desde el pedido para ver el motivo." },
      { status: 502 },
    );
  }

  const out = await doc.save();
  return new NextResponse(Buffer.from(out), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="rotulos-shalom.pdf"`,
      "cache-control": "no-store",
      "x-combinadas-omitidas": String(picked.missingOrderIds.length),
      "x-combinadas-fallidas": String(failed),
    },
  });
}
