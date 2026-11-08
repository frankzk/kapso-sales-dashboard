"use client";

// Lo que el agente de IA puede HACER (MOM §42.9, parte 3; 0323), en
// Automatizaciones › Conector de IA: el interruptor de WhatsApp y el de guías de
// Aliclik (Apagado / Simulación / Activo) con sus topes por día de Lima, y la
// lista de lo que hizo el agente —lo simulado incluido— para revisarlo. Las
// notas no tienen interruptor: van solas desde el primer día.

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, OpsButton, choiceChipClass, type BadgeTone } from "@/components/ops-ui";
import { CARD, CardHeader, HELP, NUMBER_NARROW, ROW } from "@/components/settings-ui";
import { saveAgentActionSettings, type AgentTokenFormState } from "@/app/dashboard/automatizaciones/conector/actions";
import type { AgentActionView, AgentConnectorOrg } from "@/lib/agent-tokens-access";
import { masterOrderHref } from "@/lib/order-drawer-href";
import {
  AGENT_ACTION_LABEL,
  AGENT_GUIDE_CAP_MAX,
  AGENT_MODE_LABEL,
  AGENT_STATUS_LABEL,
  AGENT_WHATSAPP_CAP_MAX,
  type AgentActionStatus,
  type AgentMode,
} from "@/lib/agent-actions";

const MODES: AgentMode[] = ["apagado", "simulacion", "activo"];

const MODE_HELP: Record<AgentMode, string> = {
  apagado: "No lo hace nunca, ni pedido en el chat.",
  simulacion: "Lo que el agente hace por su cuenta solo se registra abajo; lo que le pides y apruebas en el chat, sí se hace.",
  activo: "Lo hace de verdad, con los topes y frenos de siempre.",
};

const STATUS_TONE: Record<AgentActionStatus, BadgeTone> = {
  prevista: "neutral",
  en_curso: "info",
  simulada: "brand",
  hecha: "ok",
  rechazada: "neutral",
  error: "crit",
  incierta: "warn",
};

const WHEN = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : WHEN.format(d);
}

function ModePicker({ name, legend, value, onChange }: { name: string; legend: string; value: AgentMode; onChange: (m: AgentMode) => void }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-[13px] font-medium text-ink-700">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {MODES.map((m) => (
          <label key={m} className={cn(choiceChipClass(value === m), "cursor-pointer has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500")}>
            <input type="radio" name={name} value={m} checked={value === m} onChange={() => onChange(m)} className="sr-only" />
            {AGENT_MODE_LABEL[m]}
          </label>
        ))}
      </div>
      <p className={HELP}>{MODE_HELP[value]}</p>
    </fieldset>
  );
}

function SettingsForm({ org }: { org: AgentConnectorOrg }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(saveAgentActionSettings, {} as AgentTokenFormState);
  const [whatsapp, setWhatsapp] = useState<AgentMode>(org.actionSettings.whatsappMode);
  const [guide, setGuide] = useState<AgentMode>(org.actionSettings.guideMode);
  useEffect(() => {
    if (state.notice) router.refresh();
  }, [state, router]);
  return (
    <form action={action} className={cn(ROW, "space-y-4")}>
      <input type="hidden" name="org_id" value={org.id} />
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-3">
          <ModePicker name="whatsapp_mode" legend="WhatsApp a la clienta" value={whatsapp} onChange={setWhatsapp} />
          <label className="block text-[13px] font-medium text-ink-700">
            Tope por día
            <span className="mt-1.5 flex items-center gap-2 font-normal text-ink-600">
              <input
                type="number"
                name="whatsapp_daily_cap"
                min={1}
                max={AGENT_WHATSAPP_CAP_MAX}
                defaultValue={org.actionSettings.whatsappDailyCap}
                className={cn(NUMBER_NARROW, "w-24")}
              />
              mensajes
            </span>
          </label>
        </div>
        <div className="space-y-3">
          <ModePicker name="guide_mode" legend="Guías de Aliclik" value={guide} onChange={setGuide} />
          <label className="block text-[13px] font-medium text-ink-700">
            Tope por día
            <span className="mt-1.5 flex items-center gap-2 font-normal text-ink-600">
              <input
                type="number"
                name="guide_daily_cap"
                min={1}
                max={AGENT_GUIDE_CAP_MAX}
                defaultValue={org.actionSettings.guideDailyCap}
                className={cn(NUMBER_NARROW, "w-24")}
              />
              guías
            </span>
          </label>
        </div>
      </div>
      <p className={HELP}>
        Siempre, en cualquier posición: los permisos de quien conectó el agente; WhatsApp solo dentro de las 24 h desde el
        último mensaje de la clienta, uno por pedido cada 4 horas y nunca el mismo texto dos veces; una guía por pedido, con las
        mismas compuertas que el botón. El agente no cambia estados ni anula guías. Las notas van solas.
      </p>
      {(state.error || state.notice) && (
        <Banner tone={state.error ? "crit" : "ok"} role={state.error ? "alert" : "status"}>
          {state.error ?? state.notice}
        </Banner>
      )}
      <OpsButton type="submit" variant="primary" disabled={pending}>
        {pending ? "Guardando…" : "Guardar"}
      </OpsButton>
    </form>
  );
}

function ActionItem({ a }: { a: AgentActionView }) {
  return (
    <li className={cn(ROW, "space-y-1.5")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink-900">{AGENT_ACTION_LABEL[a.action]}</span>
        <Badge tone={STATUS_TONE[a.status]}>{AGENT_STATUS_LABEL[a.status]}</Badge>
        <Badge tone="neutral">{a.origin === "chat" ? "Pedida en el chat" : "Por su cuenta"}</Badge>
        <a href={masterOrderHref(a.orderId, "historial")} className="text-sm text-brand-700 underline">
          {a.orderName ?? "Pedido"}
        </a>
      </div>
      {a.body && <p className="whitespace-pre-line break-words text-sm text-ink-700">{a.body}</p>}
      {a.guide && (
        <p className="text-sm text-ink-700">
          {a.guide.courier ?? "Courier"}
          {a.guide.cost != null ? ` · envío S/ ${a.guide.cost.toFixed(2)}` : ""}
          {a.guide.collect != null ? ` · cobrar S/ ${a.guide.collect.toFixed(2)}` : ""}
          {a.guide.number ? ` · guía ${a.guide.number}` : ""}
        </p>
      )}
      <p className={HELP}>
        {a.storeName} · {a.tokenLabel} · {when(a.resolvedAt ?? a.createdAt)}
        {a.mode ? ` · interruptor en ${AGENT_MODE_LABEL[a.mode as AgentMode] ?? a.mode}` : ""}
        {a.errorCode ? ` · ${a.errorCode.replace(/_/g, " ")}` : ""}
      </p>
    </li>
  );
}

export function AgentActionsCard({ org, missing }: { org: AgentConnectorOrg; missing: boolean }) {
  const simulated = org.actions.filter((a) => a.status === "simulada").length;
  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title="Lo que puede hacer el agente"
        description="Notas en el pedido, WhatsApp a la clienta y guías de Aliclik. Cada token necesita además esas herramientas marcadas."
      />
      {missing ? (
        <div className={ROW}>
          <Banner tone="info" title="Falta la migración 0323">
            Hasta aplicarla, el agente solo puede leer: las herramientas de notas, WhatsApp y guías contestan que falta la migración.
          </Banner>
        </div>
      ) : (
        <>
          <SettingsForm org={org} />
          <div className={cn(ROW, "space-y-1")}>
            <h3 className="text-sm font-semibold text-ink-900">Lo que hizo el agente</h3>
            <p className={HELP}>
              Las últimas acciones, lo simulado incluido{simulated ? ` (${simulated} simuladas en esta lista)` : ""}. Las vistas
              previas que no se confirmaron no aparecen.
            </p>
          </div>
          {org.actions.length ? (
            <ul className="divide-y divide-line">
              {org.actions.map((a) => (
                <ActionItem key={a.id} a={a} />
              ))}
            </ul>
          ) : (
            <p className={cn(ROW, HELP)}>Todavía no hizo nada.</p>
          )}
        </>
      )}
    </div>
  );
}
