"use server";

// «Llamar con Anura» desde la ficha del pedido (fase 1, Click2Dial). La
// lógica y los permisos viven en lib/anura/server.ts; aquí solo se exponen al
// navegador.
//
//   startAnuraCall(orderId)      → pide la llamada (master.edit; el teléfono lo
//                                  lee el servidor; una viva por persona).
//   getAnuraCallStatus(callId)   → sondeo mientras está viva.
//   getAnuraOrderCalls(orderId)  → si sale el botón y las llamadas del pedido,
//                                  con su grabación (URL firmada de 5 min).

import { after } from "next/server";
import {
  anuraCallStatusFor,
  loadAnuraOrderPanel,
  startAnuraCallForOrder,
  type AnuraCallStatusResult,
  type AnuraOrderPanel,
  type AnuraStartResult,
} from "@/lib/anura/server";

export async function startAnuraCall(orderId: string): Promise<AnuraStartResult> {
  return startAnuraCallForOrder(orderId);
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
