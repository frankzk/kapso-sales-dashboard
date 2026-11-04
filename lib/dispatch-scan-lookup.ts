// El buscador de escaneos de Despacho y Almacén: una sola forma de resolver un
// QR, un código de salida, una guía o el número de pedido del código de barras
// (MOM §4, §29.13). Movido tal cual desde app/dashboard/pedidos/despacho/actions.ts
// (04-11-2026) para que el manifiesto de devolución (0307) use el MISMO: un
// archivo "use server" solo exporta acciones.
//
// Con el cliente del usuario (RLS): una salida de otra tienda no aparece.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabase } from "@/lib/db";
import { courierKey, dispatchScanLabel, normalizeDispatchScan } from "@/lib/dispatch";
import { OUTPUT_REPLACED_KIND, replacedOutputIds } from "@/lib/gf-replaced-output";
import { DISPATCH_SHIPMENT_COLUMNS, type DispatchShipment } from "@/lib/dispatch-access";

function outputCodeCandidate(value: string): string | null {
  const match = value.toUpperCase().match(/^(.+-S\d{2})(?:-.+)?$/);
  return match?.[1] ?? null;
}

/** Sólo letras, números y guiones: lo que un Code 39 puede llevar como pedido. */
const ORDER_NAME_SCAN = /^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/;

/**
 * Devuelve TODAS las salidas que un escaneo puede estar designando. El QR, el
 * código de salida y la guía identifican una caja concreta; el código de barras
 * del rótulo lleva el número de pedido (MOM §4), que puede tener varias salidas.
 * Quien llama decide con `pickDispatchScanTarget` cuál corresponde a su tarea.
 */
export async function findScanCandidatesWith(sb: SupabaseClient, rawCode: string): Promise<ScanCandidates> {
  const code = normalizeDispatchScan(rawCode);
  if (!code) return NO_SCAN_CANDIDATES;
  const attempts: Array<{ column: string; value: string }> = [];
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(code)) {
    attempts.push({ column: "qr_token", value: code });
  }
  const outputCode = outputCodeCandidate(code);
  if (outputCode) attempts.push({ column: "output_code", value: outputCode });
  attempts.push({ column: "guide_code", value: code });

  for (const attempt of attempts) {
    const query = sb.from("shipments").select(DISPATCH_SHIPMENT_COLUMNS).limit(2);
    const { data } = attempt.column === "qr_token"
      ? await query.eq(attempt.column, attempt.value)
      : await query.ilike(attempt.column, attempt.value.replace(/[%_]/g, "\\$&"));
    if (data?.length === 1) return { candidates: [data[0] as unknown as DispatchShipment], byOrderName: false, hold: null };
  }

  // El rótulo imprime `#KP126875`; el lector entrega `KP126875`. Aceptamos ambas.
  if (ORDER_NAME_SCAN.test(code)) {
    const { data } = await sb
      .from("shipments")
      .select(DISPATCH_SHIPMENT_COLUMNS)
      .or(`order_name.ilike.${code},order_name.ilike.#${code}`)
      .limit(10);
    const candidates = (data ?? []) as unknown as DispatchShipment[];
    if (candidates.length) return { candidates, byOrderName: true, hold: await replacedOutHold(candidates) };
  }
  return NO_SCAN_CANDIDATES;
}

/**
 * Las salidas que un escaneo designa. `byOrderName`: se llegó por el número de
 * pedido (el código de barras del rótulo), no por la caja. `hold`: el número
 * de pedido no elige ninguna salida y el escaneo pide el QR.
 */
export interface ScanCandidates {
  candidates: DispatchShipment[];
  byOrderName: boolean;
  hold: string | null;
}

export const NO_SCAN_CANDIDATES: ScanCandidates = { candidates: [], byOrderName: false, hold: null };

/**
 * «Sacar con salida nueva» (0248, MOM §29.13): mientras la caja reemplazada
 * siga fuera, el pedido tiene dos cajas con el mismo código de barras —la que
 * vuelve con el motorizado y la nueva—. El número de pedido no dice cuál está
 * en la mano: no elige ninguna, ni para tomar, asignar, recibir o cotejar.
 */
export async function replacedOutHold(candidates: DispatchShipment[]): Promise<string | null> {
  if (candidates.length < 2) return null;
  const returning = candidates.filter((candidate) => courierKey(candidate.courier) === "propio" && candidate.custody_state === "retorno");
  if (!returning.length) return null;
  const { data } = await createAdminSupabase()
    .from("order_events")
    .select("kind,shipment_id")
    .eq("kind", OUTPUT_REPLACED_KIND)
    .in("shipment_id", returning.map((candidate) => candidate.id));
  const replaced = replacedOutputIds((data ?? []) as { kind: string; shipment_id: string | null }[]);
  const out = returning.find((candidate) => replaced.has(candidate.id));
  if (!out) return null;
  return `${out.order_name ?? "Ese pedido"} tiene ${dispatchScanLabel(out)} en devolución (reemplazada por otra salida) y sus cajas llevan el mismo código de barras: escanea el QR de la caja.`;
}

export const SCAN_NOT_FOUND = "No encontramos una salida con ese QR, guía o número de pedido.";

export function ambiguousScanError(options: DispatchShipment[]): string {
  const codes = options.map(dispatchScanLabel).join(", ");
  return `Ese pedido tiene ${options.length} salidas (${codes}). Escanea el QR o el código de la salida.`;
}

