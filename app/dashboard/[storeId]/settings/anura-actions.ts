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
//
// Fase 2 (el teléfono dentro de Kapta, solo salidas):
//   saveAnuraSipSettings(storeId, { domain, wsUrl?, port? })
//                                                   → la central SIP de la org.
//   saveAnuraSipCredentials(storeId, extensionId, { domain, wsUrl?, port?, sipUser?, password })
//                                                   → «Probar y guardar»: SOLO tras un
//                                                      registro aceptado por Anura en el
//                                                      navegador; guarda la clave cifrada.
//   removeAnuraSipCredentials(storeId, extensionId) → «Quitar clave» (vuelve a la fase 1).
//   getAnuraTestPhone(storeId, extension?)          → las credenciales del anexo PROPIO
//                                                      para la llamada de prueba.
//   reportAnuraTestPhoneRejected(storeId, input)    → Anura rechazó la clave guardada.

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { env } from "@/lib/env";
import {
  anuraTestPhoneFor,
  loadAnuraSettings,
  removeAnuraExtensionFor,
  removeAnuraSipCredentialsFor,
  reportAnuraPhoneRejectedFor,
  saveAnuraExtensionFor,
  saveAnuraSipCredentialsFor,
  saveAnuraSipSettingsFor,
  setAnuraExtensionActiveFor,
  startAnuraTestCallFor,
  type AnuraMutationResult,
  type AnuraPhoneCredentialsResult,
  type AnuraSettingsResult,
  type AnuraSipCredentialsInput,
  type AnuraSipSettingsInput,
  type AnuraStartResult,
} from "@/lib/anura/server";
import type { AnuraRegistrationFailureKind } from "@/lib/anura/sip-phone";

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

export async function saveAnuraSipSettings(storeId: string, input: AnuraSipSettingsInput): Promise<AnuraMutationResult> {
  return refresh(storeId, await saveAnuraSipSettingsFor(storeId, input));
}

export async function saveAnuraSipCredentials(storeId: string, extensionId: string, input: AnuraSipCredentialsInput): Promise<AnuraMutationResult> {
  return refresh(storeId, await saveAnuraSipCredentialsFor(storeId, extensionId, input));
}

export async function removeAnuraSipCredentials(storeId: string, extensionId: string): Promise<AnuraMutationResult> {
  return refresh(storeId, await removeAnuraSipCredentialsFor(storeId, extensionId));
}

export async function getAnuraTestPhone(storeId: string, extension?: string | null): Promise<AnuraPhoneCredentialsResult> {
  return anuraTestPhoneFor(storeId, extension ?? null);
}

export async function reportAnuraTestPhoneRejected(
  storeId: string,
  input: { credentialVersion: string; kind: AnuraRegistrationFailureKind; status?: number | null },
): Promise<{ ok: true; marked: boolean } | { ok: false; error: string }> {
  const result = await reportAnuraPhoneRejectedFor({ storeId }, input);
  if (result.ok && result.marked) revalidatePath(`/dashboard/${storeId}/settings`);
  return result;
}
