// Correo de marketing con Resend (owner, 25-11-2026: «arma la sincronización
// con Resend»; MOM §46). Lo puro: los tramos, los nombres que Kapta usa en
// Resend, qué correos no se suben, el CSV y cómo se lee lo que Resend contesta.
//
// Kapta sube a Resend los clientes del historial de Shopify que aceptaron
// publicidad (§37), por tienda y por su último pedido. Las campañas se arman y
// se envían en Resend; Kapta no envía correos.

import { toCsv } from "@/lib/csv";

export type ResendBucket = "6m" | "12m" | "todos";

export interface ResendBucketInfo {
  key: ResendBucket;
  /** Meses hacia atrás del último pedido; null = todos los que aceptan publicidad. */
  months: number | null;
  label: string;
  /** Lo que va tras el nombre de la tienda en el segmento de Resend. */
  segment: string;
  help: string;
}

/**
 * Los tramos, del más chico al más grande. Se suman: el de 12 meses trae
 * también a los de 6, y «todos» a los dos. Se sube primero el de 6 meses: el
 * dominio nuevo calienta con quien compró hace poco y abre más.
 */
export const RESEND_BUCKETS: readonly ResendBucketInfo[] = [
  {
    key: "6m",
    months: 6,
    label: "Pidieron en los últimos 6 meses",
    segment: "pidieron en 6 meses",
    help: "Empieza por aquí: es la lista que más abre.",
  },
  {
    key: "12m",
    months: 12,
    label: "Pidieron en los últimos 12 meses",
    segment: "pidieron en 12 meses",
    help: "Incluye a los de 6 meses. Súbela cuando los primeros envíos salgan bien.",
  },
  {
    key: "todos",
    months: null,
    label: "Todos los que aceptan publicidad",
    segment: "todos los suscritos",
    help: "Incluye listas viejas. Súbela al final: muchos correos ya no existen.",
  },
];

export function isResendBucket(value: unknown): value is ResendBucket {
  return value === "6m" || value === "12m" || value === "todos";
}

export function resendBucket(key: ResendBucket): ResendBucketInfo {
  return RESEND_BUCKETS.find((b) => b.key === key)!;
}

/**
 * Dominios mal escritos que no se suben: un correo a «gmial.com» rebota, y los
 * rebotes bajan la reputación del dominio con que se envía.
 */
export const RESEND_TYPO_DOMAINS: readonly string[] = [
  "gimail.com",
  "gmial.com",
  "gmil.com",
  "gmal.com",
  "gmai.com",
  "gamil.com",
  "gmaill.com",
  "gnail.com",
  "gmail.con",
  "gmail.co",
  "gmail.cm",
  "gmail.om",
  "hotmal.com",
  "hotmial.com",
  "hotmai.com",
  "hotmil.com",
  "hotmail.con",
  "hotmail.co",
  "hotmail.cm",
  "homail.com",
  "outlok.com",
  "outlook.con",
  "yaho.com",
  "yahoo.con",
  "yahooo.com",
  "iclod.com",
  "icloud.con",
];

const TYPO = new Set(RESEND_TYPO_DOMAINS);

/** Resend corta el nombre de un tema en 50 caracteres. */
export const RESEND_TOPIC_NAME_MAX = 50;

/** El tema de la tienda: la baja de una marca no da de baja la otra. */
export function resendTopicName(storeName: string): string {
  return storeName.trim().slice(0, RESEND_TOPIC_NAME_MAX).trim();
}

export function resendTopicDescription(storeName: string): string {
  return `Novedades y ofertas de ${storeName.trim()}`.slice(0, 200);
}

/** «Kenku Peru · pidieron en 6 meses». */
export function resendSegmentName(storeName: string, bucket: ResendBucket): string {
  return `${storeName.trim()} · ${resendBucket(bucket).segment}`;
}

/** La llave con que Kapta guarda el id del segmento: «<tienda>:<tramo>». */
export function resendSegmentKey(storeId: string, bucket: ResendBucket): string {
  return `${storeId}:${bucket}`;
}

export interface ResendContactRow {
  email: string;
  first_name: string | null;
  last_name: string | null;
  last_order_at?: string | null;
  orders?: number | null;
}

export interface ResendContact {
  email: string;
  first_name: string;
  last_name: string;
}

const EMAIL = /^[^@\s,;<>"']+@[^@\s,;<>"']+\.[a-z]{2,}$/i;
/** Lo que una hoja de cálculo tomaría por fórmula. */
const FORMULA_START = /^[=+\-@\t\r]+/;

function cleanName(value: string | null | undefined): string {
  return (value ?? "").replace(/[\r\n\t]+/g, " ").replace(FORMULA_START, "").replace(/\s+/g, " ").trim().slice(0, 100);
}

/**
 * Lo que se sube: correos válidos, sin repetir, sin dominios mal escritos. El
 * nombre va limpio (sin saltos de línea ni un «=» delante). `excluded` cuenta
 * lo que se quedó fuera.
 */
export function filterResendContacts(rows: readonly ResendContactRow[]): { contacts: ResendContact[]; excluded: number } {
  const seen = new Set<string>();
  const contacts: ResendContact[] = [];
  let excluded = 0;
  for (const row of rows) {
    const email = (row.email ?? "").trim().toLowerCase();
    const domain = email.split("@")[1] ?? "";
    if (!EMAIL.test(email) || FORMULA_START.test(email) || TYPO.has(domain) || seen.has(email)) {
      excluded += 1;
      continue;
    }
    seen.add(email);
    contacts.push({ email, first_name: cleanName(row.first_name), last_name: cleanName(row.last_name) });
  }
  return { contacts, excluded };
}

/**
 * El CSV que se sube: `email,first_name,last_name`, las cabeceras que Resend
 * reconoce solas (sin mapa de columnas). Sin BOM: con él, la primera cabecera
 * deja de ser «email».
 */
export function resendContactsCsv(contacts: readonly ResendContact[]): string {
  return toCsv(contacts, [
    { header: "email", value: (c) => c.email },
    { header: "first_name", value: (c) => c.first_name },
    { header: "last_name", value: (c) => c.last_name },
  ]);
}

export function resendCsvFilename(storeName: string, bucket: ResendBucket, day: string): string {
  const slug = storeName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `resend_${slug || "tienda"}_${bucket}_${day}.csv`;
}

export type ResendImportStatus = "enviada" | "procesando" | "completada" | "fallida";

/** El estado de Resend (`queued`, `in_progress`, `completed`, `failed`) en el de Kapta. */
export function resendImportStatus(apiStatus: string | null | undefined): ResendImportStatus {
  switch (apiStatus) {
    case "completed":
      return "completada";
    case "failed":
      return "fallida";
    case "queued":
    case "in_progress":
      return "procesando";
    default:
      return "enviada";
  }
}

export interface ResendImportCounts {
  total?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
}

/** «48 nuevos · 2 actualizados · 1 con error». */
export function resendImportDetail(counts: ResendImportCounts | null | undefined): string | null {
  if (!counts) return null;
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const fmt = (v: number) => v.toLocaleString("es-PE");
  const parts = [
    n(counts.created) ? `${fmt(n(counts.created))} nuevos` : null,
    n(counts.updated) ? `${fmt(n(counts.updated))} actualizados` : null,
    n(counts.skipped) ? `${fmt(n(counts.skipped))} omitidos` : null,
    n(counts.failed) ? `${fmt(n(counts.failed))} con error` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Las claves de Resend empiezan con «re_». */
export function looksLikeResendKey(key: string): boolean {
  return /^re_[A-Za-z0-9_-]{16,}$/.test(key.trim());
}

/** Lo que se muestra de la clave guardada: «re_…a1b2». */
export function resendKeyHint(key: string): string {
  const k = key.trim();
  return `re_…${k.slice(-4)}`;
}

export interface ResendApiError {
  status: number | null;
  name?: string | null;
  message?: string | null;
}

/** Lo que pasó, en palabras, para la persona que sube la lista. */
export function resendErrorMessage(error: ResendApiError): string {
  const name = error.name ?? "";
  if (name === "restricted_api_key") {
    return "La clave es solo de envío. En Resend crea una con permiso «Full access» y pégala aquí.";
  }
  if (error.status === 401 || error.status === 403 || name === "invalid_api_key" || name === "missing_api_key") {
    return "Resend no aceptó la clave. Revisa que esté completa y que no la hayas borrado en Resend.";
  }
  if (error.status === 429 || name === "rate_limit_exceeded") {
    return "Resend pidió esperar un momento. Vuelve a intentarlo en un minuto.";
  }
  if (error.status === null) {
    return "No pudimos hablar con Resend. Vuelve a intentarlo en un minuto.";
  }
  const detail = (error.message ?? "").trim();
  return detail ? `Resend contestó: ${detail.slice(0, 300)}` : `Resend contestó con un error (HTTP ${error.status}).`;
}

export const RESEND_MIGRATION_MISSING = "Falta aplicar la migración 0355 (correo con Resend) en la base.";

/** Sin la 0355: la tabla o la función no existen. */
export function isResendMigrationMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  if (e.code !== "42P01" && e.code !== "PGRST205" && e.code !== "PGRST202" && e.code !== "42883") return false;
  return [e.message, e.details, e.hint].some((t) => typeof t === "string" && /\bresend_(?:settings|imports|marketing_\w+)\b/.test(t));
}
