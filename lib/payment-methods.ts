// Las cuentas que se le ENSEÑAN al cliente para pagar (migración 0166).
//
// No confundir con `store_collection_accounts` (0126): esa lista sirve para
// VERIFICAR un comprobante —guarda tres dígitos del celular y el nombre tal
// como lo escribe la billetera— y esta sirve para que el cliente PAGUE: guarda
// el número completo y cómo se presenta. Son dos preguntas distintas. Mezclarlas
// haría que cambiar la cuenta que se muestra rompiera la que se verifica.
//
// La parte pura —qué se contesta a cada botón— no toca la base: la importan
// igual el webhook, las pruebas y, el día que haga falta, el bot de Kapso.

import type { SupabaseClient } from "@supabase/supabase-js";

export const PAYMENT_METHOD_KINDS = ["yape", "plin", "banco", "billetera"] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

export interface PaymentMethod {
  id: string;
  kind: PaymentMethodKind;
  /** «BCP», «YAPE 1», «LUKITA - PLIN - AGORA». */
  label: string;
  /** A nombre de quién, tal como se quiere leer. */
  holder: string;
  /** Número de cuenta o celular, completo. */
  account: string;
  /** «CUENTA CORRIENTE BCP SOLES». Opcional. */
  detail: string | null;
  primaryYape: boolean;
  active: boolean;
  sort: number;
}

/** Un celular peruano se lee mejor en tres grupos: 930 555 309. Cualquier otra
 *  cosa —una cuenta bancaria con guiones— se deja tal cual. */
export function displayAccount(account: string): string {
  const digits = account.replace(/\s+/g, "");
  if (/^\d{9}$/.test(digits)) return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  return account.trim();
}

/** La cuenta Yape principal, o la primera activa de tipo Yape, o `null`. */
export function primaryYape(methods: readonly PaymentMethod[]): PaymentMethod | null {
  const active = methods.filter((m) => m.active);
  return active.find((m) => m.primaryYape) ?? active.find((m) => m.kind === "yape") ?? null;
}

/**
 * Lo que se contesta a «Pagar con Yape»: una línea, para que quien está con el
 * celular en la mano la copie de un vistazo. «YAPE GRUPO GF SAC 930 555 309».
 */
export function yapeQuickReply(methods: readonly PaymentMethod[]): string | null {
  const y = primaryYape(methods);
  if (!y) return null;
  return `YAPE ${y.holder.toUpperCase()} ${displayAccount(y.account)}`;
}

/** Solo el número, para {{yape}} de la plantilla: «930 555 309». */
export function yapeNumberParam(methods: readonly PaymentMethod[]): string | null {
  const y = primaryYape(methods);
  return y ? displayAccount(y.account) : null;
}

/**
 * Lo que se contesta a «Transferencia / Depósito»: todas las cuentas activas,
 * en el orden configurado, cada una con su titular y su número en línea aparte
 * —el número solo, para que se pueda copiar sin arrastrar texto—.
 */
export function formatTransferAccounts(methods: readonly PaymentMethod[]): string | null {
  const active = methods
    .filter((m) => m.active)
    .slice()
    .sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
  if (!active.length) return null;
  return active
    .map((m) => {
      const detail = m.detail?.trim() ? `, ${m.detail.trim()}` : "";
      return `${m.label}: A nombre de ${m.holder}${detail}:\n${displayAccount(m.account)}`;
    })
    .join("\n\n");
}

interface Row {
  id: string;
  kind: string;
  label: string;
  holder: string;
  account: string;
  detail: string | null;
  primary_yape: boolean;
  active: boolean;
  sort: number;
}

export function rowToPaymentMethod(row: Row): PaymentMethod {
  return {
    id: row.id,
    kind: (PAYMENT_METHOD_KINDS as readonly string[]).includes(row.kind)
      ? (row.kind as PaymentMethodKind)
      : "banco",
    label: row.label,
    holder: row.holder,
    account: row.account,
    detail: row.detail ?? null,
    primaryYape: Boolean(row.primary_yape),
    active: Boolean(row.active),
    sort: Number(row.sort) || 0,
  };
}

export const PAYMENT_METHOD_COLUMNS = "id,kind,label,holder,account,detail,primary_yape,active,sort";

/**
 * Las cuentas de una tienda, activas o no (quien edita necesita ver las
 * retiradas). Ante un fallo de lectura devuelve la lista VACÍA: sin cuentas no
 * se contesta ningún botón y no se manda el aviso, que es el lado barato del
 * error — mandarle al cliente una cuenta inventada no lo es.
 */
export async function loadStorePaymentMethods(
  admin: SupabaseClient,
  storeId: string,
): Promise<PaymentMethod[]> {
  const { data, error } = await admin
    .from("store_payment_methods")
    .select(PAYMENT_METHOD_COLUMNS)
    .eq("store_id", storeId)
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    console.error(`cuentas de cobro visibles: no se pudieron leer — ${error.message}`);
    return [];
  }
  return ((data ?? []) as unknown as Row[]).map(rowToPaymentMethod);
}
