"use client";

// Ajustes › «Telefonía Anura» (fase 1, Click2Dial; MOM §8.6). Lo ve quien
// administra la tienda (`stores.manage`). Una sola central para la org: el
// token de Click2Dial vive en Vercel (`ANURA_CLICK2DIAL_TOKEN`) y aquí solo se
// dice si está, nunca su valor. La sección enseña la dirección de los avisos
// y la plantilla para pegar en Anura, los pasos del panel de Anura, el anexo
// de cada persona, la «Llamada de prueba» y los últimos avisos (30 días, con
// los teléfonos enmascarados).
//
// Carga sus datos con su acción al abrirse (no los manda la página). Del
// servidor solo importa acciones y TIPOS: lo vigila `test/anura-ui.test.ts`.

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton } from "@/components/ops-ui";
import { CARD, CardHeader, CodeLine, EmptyRow, Field, HELP, ROW, RowList, SettingsSection } from "@/components/settings-ui";
import { IconCopy } from "@/components/icons";
import { copyLabel, useCopyToClipboard } from "@/components/copy-button";
import {
  getAnuraSettings,
  removeAnuraExtension,
  saveAnuraExtension,
  setAnuraExtensionActive,
  startAnuraTestCall,
} from "@/app/dashboard/[storeId]/settings/anura-actions";
import { getAnuraCallStatus } from "@/app/dashboard/pedidos/anura-actions";
import type { AnuraCallLive, AnuraMutationResult, AnuraSettingsData } from "@/lib/anura/server";
import { ANURA_EVENT_RETENTION_DAYS, ANURA_POLL_INTERVAL_MS, anuraPeruCalled } from "@/lib/anura/events";
import {
  ANURA_AFTER_PANEL_STEPS,
  ANURA_EVENT_OUTCOME_LABEL,
  ANURA_MAX_POLL_FAILURES,
  ANURA_PANEL_STEPS,
  anuraEndedLine,
  anuraStartErrorTitle,
} from "@/lib/anura/ui";

const SECTION_ID = "anura";
const TITLE = "Telefonía Anura";

const WHEN = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : WHEN.format(d);
}

const OUTCOME_TONE = { aplicado: "ok", repetido: "neutral", ignorado: "neutral", error: "crit" } as const;

function CopyRow({ label, value }: { label: string; value: string }) {
  const { state, copy } = useCopyToClipboard();
  return (
    <div className="space-y-1.5">
      <p className="text-[13px] font-medium leading-5 text-ink-700">{label}</p>
      <div className="flex flex-wrap items-stretch gap-2">
        <CodeLine>{value}</CodeLine>
        <OpsButton onClick={() => copy(value)} className="h-auto min-h-9">
          <IconCopy />
          {copyLabel(state)}
        </OpsButton>
      </div>
    </div>
  );
}

export function AnuraSettingsSection({ storeId }: { storeId: string }) {
  const [data, setData] = useState<AnuraSettingsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [result, setResult] = useState<AnuraMutationResult | null>(null);
  const [pending, startTransition] = useTransition();
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const res = await getAnuraSettings(storeId);
      if (n !== seq.current) return;
      if (res.ok) {
        setData(res.data);
        setLoadError(null);
      } else {
        setLoadError(res.error);
      }
    } catch {
      if (n === seq.current) setLoadError("No se pudo leer la configuración de Anura. Recarga la página.");
    }
  }, [storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  function mutate(action: () => Promise<AnuraMutationResult>) {
    startTransition(async () => {
      try {
        const res = await action();
        setResult(res);
        if (res.ok) await load();
      } catch (e) {
        setResult({ ok: false, error: (e as Error).message || "No se pudo guardar." });
      }
    });
  }

  if (loadError && !data) {
    return (
      <SettingsSection id={SECTION_ID} title={TITLE}>
        <Banner tone="crit" role="alert">
          {loadError}
        </Banner>
      </SettingsSection>
    );
  }

  if (!data) {
    return (
      <SettingsSection id={SECTION_ID} title={TITLE}>
        <p className={cn(CARD, ROW, HELP)}>Cargando la configuración de Anura…</p>
      </SettingsSection>
    );
  }

  if (data.migrationMissing) {
    return (
      <SettingsSection id={SECTION_ID} title={TITLE} badge={<Badge tone="neutral">Sin migración</Badge>}>
        <p className={cn(CARD, ROW, HELP)}>
          Falta aplicar la migración 0310 en la base. Hasta entonces no hay anexos y «Llamar con Anura» no sale en la ficha.
        </p>
      </SettingsSection>
    );
  }

  const activeExtensions = data.extensions.filter((e) => e.active);
  const badge = !data.configured ? (
    <Badge tone="neutral">Sin token</Badge>
  ) : activeExtensions.length === 0 ? (
    <Badge tone="warn">Sin anexos</Badge>
  ) : (
    <Badge tone="ok">
      Activo · {activeExtensions.length} anexo{activeExtensions.length === 1 ? "" : "s"}
    </Badge>
  );

  return (
    <SettingsSection
      id={SECTION_ID}
      title={TITLE}
      badge={badge}
      description={
        <>
          <p>
            «Llamar con Anura» en la ficha del pedido: Anura hace sonar <strong>tu teléfono de Anura</strong> (la terminal
            principal de tu anexo) y, cuando contestas, marca a la clienta. Kapta no guarda usuarios ni claves SIP.
          </p>
          <p>
            Una sola central para toda la organización. El botón sale a quien puede editar el Master, tiene un anexo activo
            aquí abajo y el pedido tiene un celular peruano. Como «Llamar desde Kapta», la llamada queda en el historial del
            pedido y el resultado se sigue registrando en la confirmación.
          </p>
        </>
      }
      actions={
        <OpsButton size="sm" onClick={() => void load()} disabled={pending} className="pointer-coarse:h-11">
          Actualizar
        </OpsButton>
      }
    >
      {result && (
        <Banner tone={result.ok ? "ok" : "crit"} role={result.ok ? "status" : "alert"}>
          <p className="break-words">{result.ok ? result.notice : result.error}</p>
        </Banner>
      )}

      <div className={cn(CARD, "divide-y divide-line")}>
        <CardHeader
          title="Token de Click2Dial"
          description={
            data.configured
              ? "Configurado en el servidor (ANURA_CLICK2DIAL_TOKEN). Kapta nunca lo muestra."
              : "Sin token, «Llamar con Anura» no sale en ninguna ficha. Se guarda en Vercel como ANURA_CLICK2DIAL_TOKEN (lo copia quien administra la plataforma desde Anura → Integraciones → Click 2 Dial)."
          }
          aside={<Badge tone={data.configured ? "ok" : "neutral"}>{data.configured ? "Configurado" : "No configurado"}</Badge>}
        />
      </div>

      <WebhookCard data={data} />

      <StepsCard />

      <ExtensionsCard data={data} pending={pending} storeId={storeId} mutate={mutate} />

      <TestCallCard storeId={storeId} data={data} />

      <EventsCard data={data} onRefresh={() => void load()} pending={pending} />
    </SettingsSection>
  );
}

function WebhookCard({ data }: { data: AnuraSettingsData }) {
  const template = useCopyToClipboard();
  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title="Avisos de Anura (webhook)"
        description="Anura avisa cada llamada (START, TALK y END) a esta dirección. Lleva el token de la organización: no la compartas fuera del panel de Anura. Si cambia la clave de cifrado del servidor, cambia también la dirección y hay que volver a pegarla."
      />
      {data.webhook ? (
        <div className={cn(ROW, "space-y-4")}>
          <CopyRow label="Dirección completa" value={data.webhook.url} />
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            {[
              ["Método", "POST"],
              ["Protocolo", data.webhook.protocol],
              ["Puerto", String(data.webhook.port)],
              ["Tipo", "JSON, sin autenticación"],
            ].map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-[13px] font-medium leading-5 text-ink-700">{k}</dt>
                <dd className="text-ink-900">{v}</dd>
              </div>
            ))}
          </dl>
          <CopyRow label="Host" value={data.webhook.host} />
          <CopyRow label="Ruta (sin la barra inicial)" value={data.webhook.path} />
        </div>
      ) : (
        <EmptyRow>
          No se pudo armar la dirección: falta la clave de cifrado del servidor (ENCRYPTION_KEY). Sin ella Anura recibe 401 en
          cada aviso.
        </EmptyRow>
      )}
      <div className={cn(ROW, "space-y-2")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13px] font-medium leading-5 text-ink-700">Plantilla del cuerpo (JSON)</p>
          <OpsButton size="sm" onClick={() => template.copy(data.template)}>
            <IconCopy />
            {copyLabel(template.state)}
          </OpsButton>
        </div>
        <pre translate="no" className="overflow-x-auto rounded-md bg-wash px-3 py-2 font-mono text-xs leading-5 text-ink-700 ring-1 ring-inset ring-line">
          {data.template}
        </pre>
      </div>
    </div>
  );
}

/** Un texto con `código` entre comillas invertidas. */
function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

function StepsCard() {
  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader title="Pasos en el panel de Anura" description="Una vez por central, y lo del anexo por cada asesora. Son los mismos de MOM §8.6." />
      <ol className={cn(ROW, "list-decimal space-y-2 pl-9 text-sm leading-5 text-ink-700 sm:pl-10 [&_strong]:font-semibold [&_strong]:text-ink-900")}>
        {ANURA_PANEL_STEPS.map((step) => (
          <li key={step.title}>
            <strong>{step.title}</strong> <WithCode text={step.text} />
          </li>
        ))}
      </ol>
      <p className={cn(ROW, "text-sm leading-5 text-ink-700")}>{ANURA_AFTER_PANEL_STEPS}</p>
    </div>
  );
}

function ExtensionsCard({
  data,
  pending,
  storeId,
  mutate,
}: {
  data: AnuraSettingsData;
  pending: boolean;
  storeId: string;
  mutate: (action: () => Promise<AnuraMutationResult>) => void;
}) {
  const [userId, setUserId] = useState("");
  const [extension, setExtension] = useState("");
  const withExt = new Map(data.extensions.map((e) => [e.userId, e.extension]));
  const validExt = /^[0-9]{2,6}$/.test(extension.trim());

  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title="Anexos por persona"
        description="Un anexo por persona y una persona por anexo. Sin anexo activo, a esa persona no le sale «Llamar con Anura». Para pasar un anexo a otra persona, quítaselo primero a quien lo tiene."
      />
      {data.extensions.length === 0 ? (
        <EmptyRow>Nadie tiene anexo todavía: «Llamar con Anura» no sale en ninguna ficha.</EmptyRow>
      ) : (
        <RowList>
          {data.extensions.map((e) => (
            <li key={e.id} className={cn(ROW, "flex flex-wrap items-center justify-between gap-3")}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink-900">{e.name}</p>
                <p className={HELP}>
                  Anexo <span className="tabular-nums">{e.extension}</span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={e.active ? "ok" : "neutral"}>{e.active ? "Activo" : "Apagado"}</Badge>
                <OpsButton
                  size="sm"
                  disabled={pending}
                  onClick={() => mutate(() => setAnuraExtensionActive(storeId, e.id, !e.active))}
                  className="pointer-coarse:h-11"
                >
                  {e.active ? "Apagar" : "Activar"}
                </OpsButton>
                <OpsButton
                  size="sm"
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm(`¿Quitar el anexo ${e.extension} a ${e.name}? Dejará de ver «Llamar con Anura».`)) {
                      mutate(() => removeAnuraExtension(storeId, e.id));
                    }
                  }}
                  className="pointer-coarse:h-11"
                >
                  Quitar
                </OpsButton>
              </div>
            </li>
          ))}
        </RowList>
      )}
      <form
        className={cn(ROW, "flex flex-wrap items-end gap-3")}
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!userId || !validExt) return;
          mutate(async () => {
            const res = await saveAnuraExtension(storeId, userId, extension.trim());
            if (res.ok) {
              setUserId("");
              setExtension("");
            }
            return res;
          });
        }}
      >
        <Field label="Persona" htmlFor="anura-ext-user" className="min-w-56 flex-1">
          <select id="anura-ext-user" value={userId} onChange={(e) => setUserId(e.target.value)} className={FIELD}>
            <option value="">Elige a una persona…</option>
            {data.people.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
                {withExt.has(p.userId) ? ` · anexo ${withExt.get(p.userId)}` : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Anexo" htmlFor="anura-ext-number" hint="De 2 a 6 dígitos." className="w-32">
          <input
            id="anura-ext-number"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={extension}
            onChange={(e) => setExtension(e.target.value.replace(/\D/g, ""))}
            placeholder="101"
            className={cn(FIELD, "tabular-nums")}
          />
        </Field>
        <OpsButton type="submit" variant="primary" disabled={pending || !userId || !validExt} className="mb-[26px] pointer-coarse:h-11">
          {userId && withExt.has(userId) ? "Cambiar anexo" : "Asignar"}
        </OpsButton>
      </form>
    </div>
  );
}

function TestCallCard({ storeId, data }: { storeId: string; data: AnuraSettingsData }) {
  const [phone, setPhone] = useState("");
  const [extension, setExtension] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<{ title: string; text: string } | null>(null);
  const [call, setCall] = useState<AnuraCallLive | null>(null);
  const [pollTrouble, setPollTrouble] = useState(false);
  const activeExtensions = data.extensions.filter((e) => e.active);
  const valid = anuraPeruCalled(phone) !== null;

  const callId = call?.id ?? null;
  const active = call?.active ?? false;
  useEffect(() => {
    if (!callId || !active) return;
    let stopped = false;
    let timer = 0;
    let failures = 0;
    const tick = async () => {
      try {
        const res = await getAnuraCallStatus(callId);
        if (stopped) return;
        if (res.ok) {
          failures = 0;
          setPollTrouble(false);
          setCall(res.call);
          if (!res.call.active) return;
        } else {
          setError({ title: "No se pudo seguir la llamada", text: res.error });
          return;
        }
      } catch {
        if (stopped) return;
        failures += 1;
        if (failures >= ANURA_MAX_POLL_FAILURES) {
          setPollTrouble(true);
          return;
        }
      }
      timer = window.setTimeout(() => void tick(), ANURA_POLL_INTERVAL_MS);
    };
    timer = window.setTimeout(() => void tick(), ANURA_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [callId, active]);

  async function start() {
    setStarting(true);
    setError(null);
    setPollTrouble(false);
    setCall(null);
    try {
      const res = await startAnuraTestCall(storeId, phone, extension || null);
      if (res.ok) {
        const status = await getAnuraCallStatus(res.callId).catch(() => null);
        if (status?.ok) setCall(status.call);
        else setError({ title: "Llamada pedida", text: `Anura va a hacer sonar el anexo ${res.extension} y luego marcará al ${res.toMasked}.` });
      } else {
        setError({ title: anuraStartErrorTitle(res.code), text: res.error });
        // Ya hay una viva, o Anura no respondió y puede que llame igual: se sigue.
        if (res.activeCallId) {
          const status = await getAnuraCallStatus(res.activeCallId).catch(() => null);
          if (status?.ok) setCall(status.call);
        }
      }
    } catch (e) {
      setError({ title: "No se pudo llamar", text: (e as Error).message || "Vuelve a intentar." });
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title="Llamada de prueba"
        description="Anura hace sonar el anexo y, al contestar, marca al celular que escribas. No cuenta como intento de ningún pedido ni queda en ningún historial."
      />
      <form
        className={cn(ROW, "flex flex-wrap items-end gap-3")}
        onSubmit={(ev) => {
          ev.preventDefault();
          if (valid && !starting && !active) void start();
        }}
      >
        <Field label="Celular peruano" htmlFor="anura-test-phone" hint="9 dígitos, empieza por 9." className="min-w-48 flex-1">
          <input
            id="anura-test-phone"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="987654321"
            className={cn(FIELD, "tabular-nums")}
          />
        </Field>
        <Field label="Con el anexo" htmlFor="anura-test-ext" hint="El tuyo, o el de otra persona." className="min-w-48">
          <select id="anura-test-ext" value={extension} onChange={(e) => setExtension(e.target.value)} className={FIELD}>
            <option value="">Mi anexo</option>
            {activeExtensions.map((e) => (
              <option key={e.id} value={e.extension}>
                {e.extension} · {e.name}
              </option>
            ))}
          </select>
        </Field>
        <OpsButton
          type="submit"
          variant="primary"
          disabled={!data.configured || !valid || starting || active}
          className="mb-[26px] pointer-coarse:h-11"
        >
          {starting ? "Pidiendo…" : active ? "En llamada…" : "Llamar"}
        </OpsButton>
      </form>
      {(!data.configured || error || call || pollTrouble) && (
        <div className={cn(ROW, "space-y-2 text-sm")}>
          {!data.configured && <p className={HELP}>Sin token de Click2Dial no se puede probar.</p>}
          {error && (
            <div>
              <p className="font-medium text-crit-fg">{error.title}</p>
              <p className="mt-0.5 text-ink-700">{error.text}</p>
            </div>
          )}
          {call && (
            <div role="status" aria-live="polite">
              <p className="font-medium text-ink-900">
                {call.toMasked} · anexo {call.extension} · {call.active ? call.statusLabel : anuraEndedLine(call)}
              </p>
              {call.active && call.hint && <p className={cn(HELP, "mt-0.5")}>{call.hint}</p>}
            </div>
          )}
          {pollTrouble && call?.active && (
            <p className="text-xs text-warn-fg">
              Kapta dejó de recibir el estado de la llamada. La llamada sigue en Anura; mira «Últimos avisos de Anura» al terminar.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function EventsCard({ data, onRefresh, pending }: { data: AnuraSettingsData; onRefresh: () => void; pending: boolean }) {
  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title="Últimos avisos de Anura"
        description={`Lo que Anura mandó en los últimos ${ANURA_EVENT_RETENTION_DAYS} días (hasta 50), con los teléfonos enmascarados. «Ignorado»: una saliente que no se pidió desde Kapta.`}
        aside={
          <OpsButton size="sm" onClick={onRefresh} disabled={pending} className="pointer-coarse:h-11">
            Actualizar
          </OpsButton>
        }
      />
      {data.recentEvents.length === 0 ? (
        <EmptyRow>Todavía no llegó ningún aviso. Si ya hiciste una llamada, revisa los pasos 6 y 7 en Anura.</EmptyRow>
      ) : (
        <RowList>
          {data.recentEvents.map((e) => (
            <li key={e.id} className={cn(ROW, "space-y-1")}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="tabular-nums text-ink-500">{when(e.receivedAt)}</span>
                <span className="font-medium text-ink-900">{e.event ?? "—"}</span>
                {e.direction && <span className="text-ink-600">{e.direction === "in" ? "entrante" : "saliente"}</span>}
                {e.anuraStatus && <span className="text-ink-600">{e.anuraStatus}</span>}
                <Badge tone={OUTCOME_TONE[e.outcome]}>{ANURA_EVENT_OUTCOME_LABEL[e.outcome]}</Badge>
              </div>
              <p className={cn(HELP, "tabular-nums")}>
                {[
                  e.extension ? `anexo ${e.extension}` : null,
                  e.calling ? `de ${e.calling}` : null,
                  e.called ? `a ${e.called}` : null,
                  e.billSeconds !== null && e.billSeconds > 0 ? `${e.billSeconds} s` : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </p>
              {e.detail && <p className="break-words text-[13px] leading-5 text-ink-700">{e.detail}</p>}
            </li>
          ))}
        </RowList>
      )}
    </div>
  );
}
