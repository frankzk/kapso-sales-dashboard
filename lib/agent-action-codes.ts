// Los hashes de las acciones del agente de IA (MOM §42.9; 0323): el del texto
// («nunca el mismo texto dos veces») y el código de confirmación de un solo uso
// de la vista previa, del que se guarda solo su sha256. Aparte de
// lib/agent-actions.ts porque usa `node:crypto` y esa la importa la pantalla.

import { createHash, randomBytes } from "node:crypto";
import { comparableBody } from "@/lib/agent-actions";

/** El sha256 de la forma comparable: «nunca el mismo texto dos veces». PURA. */
export function bodyKey(text: string): string {
  return createHash("sha256").update(comparableBody(text)).digest("hex");
}

export function generateConfirmationCode(): string {
  return randomBytes(9).toString("base64url");
}

export function hashConfirmationCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

