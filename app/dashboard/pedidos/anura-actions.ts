"use server";

// «Llamar con Anura» desde la ficha del pedido (fase 1, Click2Dial). La
// lógica y los permisos viven en lib/anura/server.ts; aquí solo se exponen al
// navegador.
//
//   startAnuraCall(orderId)      → pide la llamada (master.edit; el teléfono lo
//                                  lee el servidor; una viva por persona).
//   getAnuraCallStatus(callId)   → sondeo mientras está viva.
//   getAnuraOrderCalls(orderId)  → si sale el botón, las llamadas del pedido
//                                  con su grabación (ruta del mismo origen) y
//                                  si el anexo tiene teléfono en Kapta.
//
// Fase 2 (el teléfono dentro de Kapta, solo salidas):
//   getAnuraPhone(orderId)       → las credenciales SIP del anexo PROPIO, en el
//                                  momento de llamar (master.edit + anexo activo
//                                  propio + Anura encendido para la org). Solo en
//                                  memoria del navegador; nunca en logs ni en
//                                  localStorage/sessionStorage.
//   reportAnuraPhoneRejected(orderId, input)
//                                → Anura rechazó el registro: con 401/403/407 queda
//                                  «clave rechazada»; con 404, «dominio no
//                                  reconocido» (se corrige el dominio). En los dos
//                                  casos no se vuelve a entregar esa clave.
//
// Líneas compartidas (0313, «Puede llamar con Anura»):
//   getAnuraPhone(orderId)       → sin anexo propio, RESERVA una línea libre y da
//                                  la clave de ESA línea con el id de la reserva.
//   startAnuraCall(orderId, reservationId)
//                                → el Click2Dial SOLO con esa reserva.
//   releaseAnuraReservation(id)  → el teléfono falló antes del Click2Dial: la línea
//                                  queda libre (si no llega, sola al minuto).

import { after } from "next/server";
import {
  anuraCallStatusFor,
  anuraPhoneForOrder,
  loadAnuraOrderPanel,
  releaseAnuraReservationFor,
  reportAnuraPhoneRejectedFor,
  startAnuraCallForOrder,
  type AnuraCallStatusResult,
  type AnuraOrderPanel,
  type AnuraPhoneCredentialsResult,
  type AnuraStartResult,
} from "@/lib/anura/server";
import type { AnuraRegistrationFailureKind } from "@/lib/anura/sip-phone";
import { cleanDiag } from "@/lib/anura/phone-diag";
import { createServerSupabase } from "@/lib/db";

export async function startAnuraCall(orderId: string, reservationId?: string | null): Promise<AnuraStartResult> {
  return startAnuraCallForOrder(orderId, { reservationId: reservationId ?? null });
}

export async function releaseAnuraReservation(reservationId: string): Promise<{ ok: true; released: boolean } | { ok: false; error: string }> {
  return releaseAnuraReservationFor(reservationId);
}

export async function getAnuraCallStatus(callId: string): Promise<AnuraCallStatusResult> {
  return anuraCallStatusFor(callId);
}

export async function getAnuraOrderCalls(orderId: string): Promise<AnuraOrderPanel> {
  return loadAnuraOrderPanel(orderId, {
    defer: (work) => {
      try {
        after(work);
      } catch {
        void work().catch(() => {});
      }
    },
  });
}

export async function getAnuraPhone(orderId: string): Promise<AnuraPhoneCredentialsResult> {
  return anuraPhoneForOrder(orderId);
}

export async function reportAnuraPhoneRejected(
  orderId: string,
  input: {
    credentialVersion: string;
    kind: AnuraRegistrationFailureKind;
    status?: number | null;
    domain?: string | null;
    reservationId?: string | null;
  },
): Promise<{ ok: true; marked: boolean } | { ok: false; error: string }> {
  return reportAnuraPhoneRejectedFor({ orderId }, input);
}

/**
 * Un paso del teléfono de Kapta, al log de Vercel (`[anura-phone] {...}`), para
 * diagnosticar las pruebas reales (06-11-2026). Solo con sesión; sin datos
 * personales (lib/anura/phone-diag.ts). Nunca lanza.
 */
export async function logAnuraPhoneDiag(event: string, data?: Record<string, unknown>): Promise<void> {
  try {
    const clean = cleanDiag(event, data ?? {});
    if (!clean) return;
    const sb = await createServerSupabase();
    const { data: auth } = await sb.auth.getUser();
    const user = auth?.user?.id;
    if (!user) return;
    console.log(`[anura-phone] ${JSON.stringify({ u: user.slice(0, 8), e: clean.event, ...clean.data })}`);
  } catch {
    // diagnóstico: nunca rompe el teléfono
  }
}
