"use client";

// Automatizaciones › Conector de IA › Políticas escritas (MOM §42.6, parte 2):
// lo que cada tienda escribe —cambios, devoluciones, garantías…— para que el
// agente lo lea junto a lo que Kapta calcula. Cada política vale desde su día
// (de Lima) y, si se dice, hasta otro; editarla guarda una versión nueva y
// retirarla es final. El agente lee solo las vigentes.

import { useActionState, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton, type BadgeTone } from "@/components/ops-ui";
import { CARD, CardHeader, HELP, ROW, TEXTAREA } from "@/components/settings-ui";
import {
  retireStorePolicy,
  saveStorePolicy,
  type PolicyFormState,
} from "@/app/dashboard/automatizaciones/conector/actions";
import type { AgentConnectorOrg, StorePolicyView } from "@/lib/agent-tokens-access";
import {
  POLICY_BODY_MAX,
  POLICY_SOURCE_MAX,
  POLICY_STATUS_LABEL,
  POLICY_TITLE_MAX,
  type PolicyStatus,
} from "@/lib/store-policies";

const initial: PolicyFormState = {};

const STATUS_TONE: Record<PolicyStatus, BadgeTone> = {
  vigente: "ok",
  programada: "info",
  vencida: "neutral",
  retirada: "neutral",
};
const STATUS_ORDER: Record<PolicyStatus, number> = { vigente: 0, programada: 1, vencida: 2, retirada: 3 };

const WHEN = new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** `YYYY-MM-DD` → `dd-mm-yyyy`, como se escriben las fechas en Kapta. */
function day(d: string): string {
  const [y, m, dd] = d.split("-");
  return `${dd}-${m}-${y}`;
}

function validity(p: StorePolicyView): string {
  return p.validUntil ? `Del ${day(p.validFrom)} al ${day(p.validUntil)}` : `Desde el ${day(p.validFrom)}, sin fecha de fin`;
}

function Result({ state }: { state: PolicyFormState }) {
  if (!state.error && !state.notice) return null;
  return (
    <Banner tone={state.error ? "crit" : "ok"} role={state.error ? "alert" : "status"}>
      <p className="whitespace-pre-line break-words">{state.error ?? state.notice}</p>
    </Banner>
  );
}

function PolicyForm({
  orgId,
  storeId,
  policy,
  today,
  onDone,
}: {
  orgId: string;
  storeId: string;
  policy: StorePolicyView | null;
  today: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(saveStorePolicy, initial);
  useEffect(() => {
    if (state.savedId && !state.error) {
      router.refresh();
      onDone();
    }
  }, [state, router, onDone]);
  return (
    <form action={action} className={cn(ROW, "space-y-3 bg-wash")}>
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="store_id" value={storeId} />
      {policy && <input type="hidden" name="policy_id" value={policy.id} />}
      <label className="block text-[13px] font-medium text-ink-700">
        Título
        <input name="title" required maxLength={POLICY_TITLE_MAX} defaultValue={policy?.title ?? ""} placeholder="Cambios y devoluciones" className={cn(FIELD, "mt-1.5")} />
      </label>
      <label className="block text-[13px] font-medium text-ink-700">
        Texto
        <textarea
          name="body"
          required
          rows={6}
          maxLength={POLICY_BODY_MAX}
          defaultValue={policy?.body ?? ""}
          placeholder="Lo que el agente le puede decir al cliente, tal cual. Por ejemplo: «Aceptamos cambios dentro de los 7 días de recibido…»."
          className={cn(TEXTAREA, "mt-1.5")}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[13px] font-medium text-ink-700">
          Vale desde
          <input type="date" name="valid_from" required defaultValue={policy?.validFrom ?? today} className={cn(FIELD, "mt-1.5")} />
        </label>
        <label className="block text-[13px] font-medium text-ink-700">
          Hasta (opcional)
          <input type="date" name="valid_until" defaultValue={policy?.validUntil ?? ""} className={cn(FIELD, "mt-1.5")} />
        </label>
      </div>
      <label className="block text-[13px] font-medium text-ink-700">
        Fuente (opcional)
        <input
          name="source"
          maxLength={POLICY_SOURCE_MAX}
          defaultValue={policy?.source ?? ""}
          placeholder="La página de cambios de la web, un acuerdo con Shalom…"
          className={cn(FIELD, "mt-1.5")}
        />
      </label>
      <Result state={state} />
      <div className="flex flex-wrap gap-2">
        <OpsButton type="submit" variant="primary" disabled={pending}>
          {pending ? "Guardando…" : policy ? "Guardar versión nueva" : "Crear política"}
        </OpsButton>
        <OpsButton type="button" onClick={onDone} disabled={pending}>
          Cancelar
        </OpsButton>
      </div>
    </form>
  );
}

function RetireButton({ orgId, policyId }: { orgId: string; policyId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState(retireStorePolicy, initial);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (state.notice && !state.error) router.refresh();
  }, [state, router]);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="policy_id" value={policyId} />
      {confirming ? (
        <>
          <span className={HELP}>¿Retirar? El agente deja de leerla y no se puede volver a editar.</span>
          <OpsButton type="submit" variant="danger" size="sm" disabled={pending}>
            {pending ? "Retirando…" : "Sí, retirar"}
          </OpsButton>
          <OpsButton type="button" size="sm" onClick={() => setConfirming(false)}>
            Cancelar
          </OpsButton>
        </>
      ) : (
        <OpsButton type="button" size="sm" onClick={() => setConfirming(true)}>
          Retirar
        </OpsButton>
      )}
      <Result state={state} />
    </form>
  );
}

function PolicyRow({
  orgId,
  policy,
  today,
  editing,
  onEdit,
  onDone,
}: {
  orgId: string;
  policy: StorePolicyView;
  today: string;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
}) {
  if (editing) return <PolicyForm orgId={orgId} storeId={policy.storeId} policy={policy} today={today} onDone={onDone} />;
  const retired = policy.status === "retirada";
  return (
    <li className={cn(ROW, "space-y-2", retired && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink-900">{policy.title}</span>
        <Badge tone={STATUS_TONE[policy.status]}>{POLICY_STATUS_LABEL[policy.status]}</Badge>
      </div>
      <p className="whitespace-pre-line break-words text-sm text-ink-700">{policy.body}</p>
      <p className={HELP}>
        {validity(policy)}
        {policy.source ? ` · Fuente: ${policy.source}` : ""} · Versión {policy.version}, {retired ? "retirada" : "guardada"} por {policy.editor} el{" "}
        {WHEN.format(new Date(policy.updatedAt))}
      </p>
      {!retired && (
        <div className="flex flex-wrap items-center gap-2">
          <OpsButton type="button" size="sm" onClick={onEdit}>
            Editar
          </OpsButton>
          <RetireButton orgId={orgId} policyId={policy.id} />
        </div>
      )}
    </li>
  );
}

export function StorePoliciesCard({ org, today, missing }: { org: AgentConnectorOrg; today: string; missing: boolean }) {
  const [storeId, setStoreId] = useState(org.stores[0]?.id ?? "");
  // «new» abre el formulario vacío; un id, la edición de esa política.
  const [editing, setEditing] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const all = useMemo(
    () =>
      org.policies
        .filter((p) => p.storeId === storeId)
        .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.title.localeCompare(b.title, "es")),
    [org.policies, storeId],
  );
  const retiredCount = all.filter((p) => p.status === "retirada").length;
  const shown = showRetired ? all : all.filter((p) => p.status !== "retirada");
  const done = useCallback(() => setEditing(null), []);

  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title="Políticas escritas"
        description="Lo que el agente lee además de lo que Kapta calcula: cambios, devoluciones, garantías, horarios… Lee solo las vigentes hoy; si ninguna cubre lo que le preguntan, no la inventa."
      />
      {missing ? (
        <div className={ROW}>
          <Banner tone="warn" role="status" title="Falta la migración 0315">
            Hay que aplicar la migración 0315 (políticas escritas) en la base. Hasta entonces el agente lee solo las políticas que Kapta calcula.
          </Banner>
        </div>
      ) : (
        <>
          <div className={cn(ROW, "flex flex-wrap items-center gap-3")}>
            {org.stores.length > 1 && (
              <div role="tablist" aria-label="Tienda" className="flex flex-wrap gap-1.5">
                {org.stores.map((s) => (
                  <OpsButton
                    key={s.id}
                    type="button"
                    role="tab"
                    aria-selected={s.id === storeId}
                    variant={s.id === storeId ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => {
                      setStoreId(s.id);
                      setEditing(null);
                    }}
                  >
                    {s.name}
                  </OpsButton>
                ))}
              </div>
            )}
            {editing !== "new" && storeId && (
              <OpsButton type="button" size="sm" onClick={() => setEditing("new")}>
                Nueva política
              </OpsButton>
            )}
          </div>
          {editing === "new" && <PolicyForm orgId={org.id} storeId={storeId} policy={null} today={today} onDone={done} />}
          {shown.length ? (
            <ul className="divide-y divide-line">
              {shown.map((p) => (
                <PolicyRow key={p.id} orgId={org.id} policy={p} today={today} editing={editing === p.id} onEdit={() => setEditing(p.id)} onDone={done} />
              ))}
            </ul>
          ) : (
            editing !== "new" && <p className={cn(ROW, HELP)}>Esta tienda todavía no tiene políticas escritas.</p>
          )}
          {retiredCount > 0 && (
            <div className={ROW}>
              <OpsButton type="button" variant="ghost" size="sm" onClick={() => setShowRetired((v) => !v)}>
                {showRetired ? "Ocultar retiradas" : `Ver retiradas (${retiredCount})`}
              </OpsButton>
            </div>
          )}
        </>
      )}
    </div>
  );
}
