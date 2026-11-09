"use server";

// La «Lista de pago adelantado» en la ficha del pedido (MOM §41): si el
// celular está en la lista, el aviso con su motivo y evidencia, y el botón
// «Enviar link de pago», que crea (o reusa) el link de Flow por LO QUE FALTA
// del total: el total si no hay comprobantes, o la diferencia si ya hay un
// adelanto (`prepayLinkPlan`). Kapta NO lo manda por WhatsApp: lo muestra para
// copiar.

import { redirect } from "next/navigation";
import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getMasterPermissions } from "@/lib/permissions-access";
import { getStoreCreds } from "@/lib/ingest";
import { env } from "@/lib/env";
import { FlowClient } from "@/lib/flow/client";
import { ensureFlowPaymentLink } from "@/lib/flow/link";
import { orgOfStore, paymentFactsOf, prepayEntryView, prepayLookup, type PrepayOrderRow } from "@/lib/prepay-list-server";
import { prepayLinkPlan, prepayRequirementMet, type PrepayEvidence, type PrepayPaymentRow } from "@/lib/prepay-list";
import { formatLimaDateTime, isUuid, PAGO_ONLINE_EXCEPTION_EVENT } from "@/lib/automations-catalog";
import { getCurrentUser } from "@/lib/access";
import { hasOrgPermission } from "@/lib/permissions-access";
import { pagoOnlineLookup } from "@/lib/pago-online-lookup";
import { addPagoOnlineException } from "@/lib/pago-online-server";
import {
  PAGO_ONLINE_REQUIREMENT_LABEL,
  pagoOnlineReasonProblem,
  pagoOnlineRequirementMet,
  type PagoOnlineRequirement,
} from "@/lib/pago-online";

export interface OrderPrepayStatus {
  listed: boolean;
  /** Ya está pagado completo: el pedido sigue, con cobro cero. */
  fullyPaid?: boolean;
  source?: "auto" | "manual";
  reason?: string;
  addedAt?: string;
  evidence?: PrepayEvidence;
  /** La tienda tiene Flow configurado: se puede crear el link. */
  flowAvailable?: boolean;
  total?: number | null;
  /** Lo que cobraría el link: el total, o la diferencia si ya hay un adelanto. */
  due?: { kind: "total" | "diferencia"; amount: number; alreadyPaid: number } | null;
  /** Por qué no hay nada que cobrar todavía (un comprobante por validar…). */
  dueProblem?: string | null;
  /**
   * «Pago solo online (lista automática)», MOM §41.11: solo cuando el celular
   * NO está en la lista de pago adelantado (que pide más). Cuentas del propio
   * cliente, nunca datos de otros.
   */
  pagoOnline?: OrderPagoOnlineStatus | null;
  error?: string;
}

export interface OrderPagoOnlineStatus {
  /** Por qué entra: `devuelto` (A) o `anulador` (B). */
  reason: "devuelto" | "anulador";
  /** Los devueltos, o los anulados del anulador. */
  failed: number | null;
  /** Sus pedidos contra entrega que cuentan (para «anuló N de M»). */
  orders: number | null;
  requirement: PagoOnlineRequirement;
  requirementLabel: string;
  /** Ya tiene lo que se pide (el adelanto validado o el pago completo): sigue. */
  met: boolean;
  /** Quien mira puede exceptuarlo (`prepay_list.manage`). */
  canExcept: boolean;
}

type OrderRow = PrepayOrderRow & { order_name: string | null; order_total: number | null };

/** El pedido, leído con los permisos de quien mira (RLS). */
async function readOrder(orderId: string): Promise<OrderRow | null> {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data } = await sb
    .from("order_master")
    .select("order_id,store_id,order_name,order_total,customer_phone,financial_status,total_refunded,payment_state,payment_gateway")
    .eq("order_id", orderId)
    .maybeSingle();
  return (data as OrderRow | null) ?? null;
}

function flowConfigured(creds: Awaited<ReturnType<typeof getStoreCreds>>): boolean {
  return Boolean(creds?.flowcl_api_key && creds.flowcl_secret_key && creds.flowcl_webhook_secret);
}

export async function loadOrderPrepayStatus(orderId: string): Promise<OrderPrepayStatus> {
  const order = await readOrder(orderId);
  if (!order) return { listed: false, error: "Sin acceso a este pedido." };
  const admin = createAdminSupabase();
  try {
    const orgId = await orgOfStore(admin, order.store_id);
    if (!orgId) return { listed: false };
    const lookup = await prepayLookup(admin, orgId, order.customer_phone);
    if (lookup.state === "unread") return { listed: false, error: "No se pudo comprobar la lista de pago adelantado." };
    if (lookup.state === "not_listed") {
      const auto = await pagoOnlineLookup(admin, orgId, order.customer_phone);
      if (auto.state === "unread") return { listed: false, error: "No se pudo comprobar la «Lista negra»." };
      if (auto.state === "not_listed") return { listed: false };
      return {
        listed: false,
        pagoOnline: {
          reason: auto.who.reason,
          failed: auto.who.failed,
          orders: auto.who.orders,
          requirement: auto.requirement,
          requirementLabel: PAGO_ONLINE_REQUIREMENT_LABEL[auto.requirement],
          met: pagoOnlineRequirementMet(auto.requirement, paymentFactsOf(order)),
          canExcept: await hasOrgPermission(orgId, "prepay_list.manage").catch(() => false),
        },
      };
    }
    const view = prepayEntryView(lookup.entry);
    const fullyPaid = prepayRequirementMet(paymentFactsOf(order));
    const creds = await getStoreCreds(order.store_id, admin).catch(() => null);
    const plan = fullyPaid
      ? null
      : await livePayments(admin, orderId).then(
          (payments) => prepayLinkPlan(payments, order.order_total),
          () => ({ ok: false as const, error: "No se pudieron leer los pagos del pedido." }),
        );
    return {
      listed: true,
      fullyPaid,
      due: plan?.ok ? { kind: plan.kind, amount: plan.amount, alreadyPaid: plan.alreadyPaid } : null,
      dueProblem: plan && !plan.ok ? plan.error : null,
      source: view.source,
      reason: view.reason,
      addedAt: formatLimaDateTime(view.addedAt),
      evidence: view.evidence,
      flowAvailable: flowConfigured(creds),
      total: order.order_total,
    };
  } catch {
    return { listed: false, error: "No se pudo comprobar la lista de pago adelantado." };
  }
}

export interface PrepayLinkResult {
  error?: string;
  link?: string;
  reused?: boolean;
  amount?: number;
  kind?: "total" | "diferencia";
  expiresAt?: string | null;
}

/** Los comprobantes del pedido (todos: el plan descarta los rechazados). Lanza si la base falla. */
async function livePayments(admin: ReturnType<typeof createAdminSupabase>, orderId: string): Promise<PrepayPaymentRow[]> {
  const { data, error } = await admin.from("order_payments").select("kind,validation_status,amount").eq("order_id", orderId);
  if (error) throw new Error(error.message);
  return (data ?? []) as PrepayPaymentRow[];
}

/** El email del pedido si lo trae; casi nunca (por eso el de la tienda de respaldo). */
async function customerEmail(admin: ReturnType<typeof createAdminSupabase>, orderId: string): Promise<string | null> {
  const { data } = await admin
    .from("orders")
    .select("contacto:raw->>contact_email,cliente:raw->customer->>email,billing:raw->billing->>email")
    .eq("id", orderId)
    .maybeSingle();
  const row = (data ?? null) as { contacto: string | null; cliente: string | null; billing?: string | null } | null;
  const email = (row?.contacto ?? row?.cliente ?? row?.billing ?? "").trim();
  return email || null;
}

/**
 * «Enviar link de pago»: el link de Flow por lo que falta (`prepayLinkPlan`):
 * `kind: 'total'` por el total si el pedido no tiene comprobantes, o
 * `'diferencia'` por el saldo si ya tiene un adelanto validado —un `total`
 * encima no cabe en el plan de cobro (0092) y el pago entraría sin
 * registrarse—. Con un comprobante por validar no crea nada. Reusa el vivo del
 * mismo importe (lib/flow/link.ts). Solo en producción y con `master.edit`,
 * como las demás acciones que escriben hacia afuera. No manda nada por
 * WhatsApp.
 */
export async function createPrepayPaymentLink(orderId: string): Promise<PrepayLinkResult> {
  const perms = await getMasterPermissions();
  if (!perms.can("master.edit")) return { error: "Tu rol no permite gestionar este pedido." };
  if (process.env.VERCEL_ENV !== "production") return { error: "Disponible solo en producción." };
  const order = await readOrder(orderId);
  if (!order) return { error: "Sin acceso a este pedido." };
  if (prepayRequirementMet(paymentFactsOf(order))) return { error: "Este pedido ya está pagado completo: no hace falta otro cobro." };
  const admin = createAdminSupabase();
  let payments: PrepayPaymentRow[];
  try {
    payments = await livePayments(admin, orderId);
  } catch {
    return { error: "No se pudieron leer los pagos del pedido. Intenta de nuevo." };
  }
  const plan = prepayLinkPlan(payments, order.order_total);
  if (!plan.ok) return { error: plan.error };
  const { kind, amount } = plan;
  const creds = await getStoreCreds(order.store_id, admin).catch(() => null);
  if (!creds || !flowConfigured(creds)) {
    return {
      error:
        kind === "total"
          ? "La tienda no tiene Flow configurado: pide el pago total por Yape y súbelo como «Pago total»."
          : "La tienda no tiene Flow configurado: pide el saldo por Yape y súbelo como «Diferencia».",
    };
  }
  const email = (await customerEmail(admin, orderId)) ?? creds.flowcl_link_email ?? "";
  if (!email) return { error: "Falta el correo de respaldo de Flow en los ajustes de la tienda." };
  const res = await ensureFlowPaymentLink(
    admin,
    {
      storeId: order.store_id,
      orderId,
      orderName: order.order_name,
      kind,
      amount,
      email,
      ttlHours: creds.flowcl_link_ttl_hours,
      yapeOnly: creds.flowcl_link_yape_only,
      subject: `${kind === "total" ? "Pago total" : "Saldo"} del pedido ${order.order_name ?? ""}`.trim(),
      currency: creds.currency,
    },
    {
      client: new FlowClient({ apiKey: creds.flowcl_api_key!, secretKey: creds.flowcl_secret_key!, baseUrl: env.flowclApiBase() }),
      siteUrl: env.siteUrl(),
      webhookSecret: creds.flowcl_webhook_secret!,
    },
  );
  if (!res.ok) return { error: `Flow no creó el link (${res.reason}). Pide el ${kind === "total" ? "pago total" : "saldo"} por Yape.` };
  return { link: res.link, reused: res.reused, amount, kind, expiresAt: res.expiresAt };
}

/**
 * «Exceptuar» desde la ficha (MOM §41.11): el cliente de este pedido sale de la
 * lista automática «Pago solo online» en Kapta desde ya, y en las tiendas
 * desde el próximo envío. Con motivo (8+ caracteres), `prepay_list.manage` en
 * la organización del pedido y solo en producción, como la lista de pago
 * adelantado. El celular sale del pedido, no del navegador.
 */
export async function exceptPagoOnlineCustomer(orderId: string, reason: string): Promise<{ error?: string; notice?: string }> {
  if (!isUuid(orderId)) return { error: "Pedido inválido." };
  const problem = pagoOnlineReasonProblem(reason);
  if (problem) return { error: problem };
  const order = await readOrder(orderId);
  if (!order) return { error: "Sin acceso a este pedido." };
  const admin = createAdminSupabase();
  const orgId = await orgOfStore(admin, order.store_id).catch(() => null);
  if (!orgId) return { error: "No se pudo leer la organización del pedido." };
  if (!(await hasOrgPermission(orgId, "prepay_list.manage"))) return { error: "Tu acceso no permite exceptuar clientes de la lista." };
  if (process.env.VERCEL_ENV !== "production") return { error: "Disponible solo en producción." };
  const user = await getCurrentUser();
  const res = await addPagoOnlineException(admin, {
    orgId,
    phone: order.customer_phone ?? "",
    reason,
    actor: user?.id ?? null,
    orderId,
    orderName: order.order_name,
  });
  if (!res.ok) return { error: res.error };
  await admin
    .from("automation_switch_events")
    .insert({ org_id: orgId, store_id: order.store_id, automation: PAGO_ONLINE_EXCEPTION_EVENT, previous: null, next: "exceptuado", actor: user?.id ?? null });
  return { notice: "Exceptuado: Kapta ya no lo frena por esta lista, y sale de la lista de las tiendas en el próximo envío." };
}
