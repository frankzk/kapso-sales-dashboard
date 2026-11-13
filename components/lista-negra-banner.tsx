"use client";

// El aviso de la «Lista negra» (MOM §41.11 «Cómo se dice»), el mismo en la
// ficha del pedido y en la del lead: título «Lista negra», el motivo, el
// requisito, qué hacer y la nota al pie. Las dos listas (la automática y la
// agregada a mano) se ven igual: solo cambian el motivo y «pago total». Los
// textos salen de lib/lista-negra-copy.ts; lo que va debajo (el link de pago,
// «Exceptuar de la Lista negra») lo pone quien lo usa.

import type { ReactNode } from "react";
import { Banner } from "@/components/ops-ui";
import {
  LN_BANNER_TITLE,
  LN_FOOTNOTE,
  lnLeadBannerAction,
  lnOrderBannerAction,
  lnRequisito,
  type LnRequirement,
} from "@/lib/lista-negra-copy";

export function ListaNegraBanner({
  motivo,
  requirement,
  context,
  met = false,
  className,
  children,
}: {
  motivo: string;
  requirement: LnRequirement;
  /** La ficha del pedido (crit si falta, info si ya cumple) o la del lead (warn). */
  context: "order" | "lead";
  met?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const tone = context === "lead" ? "warn" : met ? "info" : "crit";
  const action = context === "lead" ? lnLeadBannerAction(requirement) : lnOrderBannerAction(requirement, met);
  return (
    <Banner tone={tone} role={tone === "crit" ? "alert" : "status"} className={className} title={LN_BANNER_TITLE}>
      <p className="mt-0.5 text-[13px] leading-5 text-ink-900">{motivo}</p>
      <p className="text-[13px] leading-5">{lnRequisito(requirement)}</p>
      <p className="mt-1 text-[13px] font-medium leading-5">{action}</p>
      {children}
      <p className="mt-1.5 text-xs text-ink-500">{LN_FOOTNOTE}</p>
    </Banner>
  );
}
