"use server";

// Ajustes › «Telefonía Anura» (fase 1, Click2Dial). Lo ve y lo cambia quien
// administra la tienda (`stores.manage` en su org). La lógica vive en
// lib/anura/server.ts.
//
//   getAnuraSettings(storeId)                       → estado del token (sí/no), URL
//                                                      del webhook, plantilla, anexos,
//                                                      equipo y últimos avisos.
//   saveAnuraExtension(storeId, userId, extension)  → asigna o cambia un anexo.
//   setAnuraExtensionActive(storeId, id, active)    → lo enciende o apaga.
//   removeAnuraExtension(storeId, id)               → lo quita.
//   startAnuraTestCall(storeId, phone, extension?)  → llamada de prueba (no cuenta
//                                                      para ningún pedido).

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { env } from "@/lib/env";
import {
  loadAnuraSettings,
  removeAnuraExtensionFor,
  saveAnuraExtensionFor,
  setAnuraExtensionActiveFor,
  startAnuraTestCallFor,
  type AnuraMutationResult,
  type AnuraSettingsResult,
  type AnuraStartResult,
} from "@/lib/anura/server";

/** El origen con el que se ve Ajustes (preview o producción). */
async function siteOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : env.siteUrl();
}

function refresh(storeId: string, result: AnuraMutationResult): AnuraMutationResult {
  if (result.ok) revalidatePath(`/dashboard/${storeId}/settings`);
  return result;
}

export async function getAnuraSettings(storeId: string): Promise<AnuraSettingsResult> {
  return loadAnuraSettings(storeId, await siteOrigin());
}

export async function saveAnuraExtension(storeId: string, userId: string, extension: string): Promise<AnuraMutationResult> {
  return refresh(storeId, await saveAnuraExtensionFor(storeId, userId, extension));
}

export async function setAnuraExtensionActive(storeId: string, extensionId: string, active: boolean): Promise<AnuraMutationResult> {
  return refresh(storeId, await setAnuraExtensionActiveFor(storeId, extensionId, active));
}

export async function removeAnuraExtension(storeId: string, extensionId: string): Promise<AnuraMutationResult> {
  return refresh(storeId, await removeAnuraExtensionFor(storeId, extensionId));
}

export async function startAnuraTestCall(storeId: string, phone: string, extension?: string | null): Promise<AnuraStartResult> {
  return startAnuraTestCallFor(storeId, phone, extension ?? null);
}
