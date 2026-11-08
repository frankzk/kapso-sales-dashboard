"use server";
// «Distrito por revisar» antes de crear la guía (MOM §19.0.3). Solo LEE, con la
// sesión de quien mira (RLS por tienda): una vez al abrir la guía y otra tras
// corregir. Nunca escribe: la corrección es `updateOrderGeo`, con su auditoría.
// Si algo falla, no hay aviso (la guía se crea como siempre).

import { loadOrderDistrictMismatch } from "@/lib/district-mismatch-access";
import type { DistrictMismatch } from "@/lib/district-mismatch";

export interface GuideDestinationInput {
  district?: string | null;
  province?: string | null;
  region?: string | null;
  address?: string | null;
}

export async function loadDistrictMismatchForGuide(
  orderId: string,
  destination?: GuideDestinationInput | null,
): Promise<DistrictMismatch | null> {
  if (!orderId) return null;
  try {
    return await loadOrderDistrictMismatch(orderId, destination ?? null);
  } catch {
    return null;
  }
}
