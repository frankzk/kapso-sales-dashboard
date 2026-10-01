// Componer el rótulo de una salida Shalom: su etiqueta arriba, nuestra banda
// abajo (lib/labels/agency-rotulo.ts). Lo usan el rótulo del drawer
// (app/api/shalom/rotulo/[shipmentId]) y las guías combinadas en lote
// (app/api/shalom/rotulos): una sola composición, para que el papel no cambie
// según desde dónde se imprima.

import type { SupabaseClient } from "@supabase/supabase-js";
import QRCode from "qrcode";
import { describeShalomError } from "@/lib/shalom/client";
import { loadStoreShalom, type StoreShalom } from "@/lib/shalom/session";
import { shalomLabelPdf } from "@/lib/shalom/label-cache";
import { buildAgencyRotuloPdf } from "@/lib/labels/agency-rotulo";
import { labelItemsFor } from "@/lib/labels/line-items";
import { outputDisplayCode } from "@/lib/shipment-output";

/** Su etiqueta es una página. Techo generoso pero finito, como en `label/`. */
const MAX_BYTES = 10 * 1024 * 1024;

export const SHALOM_ROTULO_COLUMNS =
  "id,store_id,order_id,courier,guide_code,output_code,output_number,qr_token,order_name,customer_name,product,shalom_ose_id";

export interface ShalomRotuloRow {
  id: string;
  store_id: string;
  order_id: string | null;
  courier: string;
  guide_code: string | null;
  output_code: string | null;
  output_number: number | null;
  qr_token: string | null;
  order_name: string | null;
  customer_name: string | null;
  product: string | null;
  shalom_ose_id: number | null;
}

export type ShalomRotuloResult =
  | { ok: true; pdf: Uint8Array; code: string }
  | { ok: false; status: number; message: string };

/**
 * `sb` es el cliente de SESIÓN: los productos y la tienda se leen con él, porque
 * lo que el usuario no puede ver tampoco debe acabar impreso. `admin` solo
 * descifra la cuenta de Shalom de la tienda. `stores` es una caché por llamada,
 * para no cargar la misma cuenta una vez por guía en un lote.
 */
export async function composeShalomRotulo(
  sb: SupabaseClient,
  admin: SupabaseClient,
  row: ShalomRotuloRow,
  stores: Map<string, Promise<StoreShalom | null>> = new Map(),
): Promise<ShalomRotuloResult> {
  if (row.courier !== "shalom") {
    return { ok: false, status: 400, message: "esta guía no es de Shalom" };
  }
  if (!row.shalom_ose_id) {
    return {
      ok: false,
      status: 404,
      message: "Esta guía no se creó por API (llegó por el reporte), así que su rótulo hay que bajarlo de pro.shalom.pe.",
    };
  }
  // Sin QR no hay banda que valga: el doble escaneo de despacho es la mitad del
  // motivo de este papel. Es defensivo — la base lo pone al crear la salida.
  if (!row.qr_token) {
    return {
      ok: false,
      status: 409,
      message: "Esta salida no tiene QR interno; imprime el rótulo de Shalom y avisa, porque no debería pasar.",
    };
  }

  if (!stores.has(row.store_id)) stores.set(row.store_id, loadStoreShalom(admin, row.store_id));
  const store = await stores.get(row.store_id)!;
  if (!store?.shalom_pro_email) {
    return { ok: false, status: 409, message: "La tienda no tiene cuenta de Shalom Pro configurada." };
  }

  let courierPdf: Uint8Array;
  try {
    // De la caché si ya se pidió una vez. Su PDF no cambia una vez emitida la
    // guía, y pedirlo cuesta ~45 s — al filo del timeout.
    courierPdf = await shalomLabelPdf(admin, row.store_id, store, row.shalom_ose_id);
  } catch (err) {
    return { ok: false, status: 502, message: describeShalomError(err) };
  }
  if (courierPdf.byteLength > MAX_BYTES) {
    return { ok: false, status: 502, message: "el rótulo de Shalom llegó con un tamaño inesperado" };
  }

  const [{ data: order }, { data: storeRow }] = await Promise.all([
    row.order_id
      ? sb.from("orders").select("line_items").eq("id", row.order_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from("stores").select("name").eq("id", row.store_id).maybeSingle(),
  ]);

  const code = outputDisplayCode(row.output_code, row.courier) || row.output_code || row.guide_code || "";

  try {
    const pdf = await buildAgencyRotuloPdf(courierPdf, {
      code,
      guideCode: row.guide_code,
      storeName: (storeRow as { name: string | null } | null)?.name ?? null,
      orderName: row.order_name,
      customerName: row.customer_name,
      items: labelItemsFor((order as { line_items?: unknown } | null)?.line_items, row.product),
      qrPng: await QRCode.toBuffer(row.qr_token, { margin: 0, width: 320, errorCorrectionLevel: "M" }),
    });
    return { ok: true, pdf, code: code || String(row.shalom_ose_id) };
  } catch {
    // Componer puede fallar si su PDF viene corrupto o cifrado. Se dice, en vez
    // de servir un papel a medias: el rótulo suelto sigue en `/api/shalom/label`.
    return {
      ok: false,
      status: 502,
      message: "No se pudo componer el rótulo con el PDF de Shalom. Usa el rótulo suelto y avisa.",
    };
  }
}
