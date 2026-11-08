"use client";

// Ajustes › «Telefonía Anura» › «Líneas compartidas» y «Quién puede llamar»
// (0313, MOM §8.7 «Líneas compartidas»). Lo ve quien administra la tienda
// (`stores.manage`).
//
//   · «Líneas compartidas» (la forma recomendada): unos pocos anexos de Anura
//     sin dueña (empieza con 3; el plan permite hasta 10). Quien tiene
//     «Puede llamar con Anura» toma una LIBRE al llamar. Por línea: el número,
//     su clave de la «<anexo>-websocket» con el mismo «Probar y guardar» de
//     siempre (UN registro en este navegador; solo si Anura lo acepta se
//     guarda cifrada), su estado (libre, en uso por quién, clave rechazada,
//     dominio no reconocido) y quitarla.
//   · «Quién puede llamar»: las personas que gestionan pedidos (`master.edit`)
//     con su casilla «Puede llamar con Anura». Quien tiene anexo propio llama
//     con él.
//
// La clave nunca vuelve aquí. Del servidor solo se importan acciones y TIPOS
// (lo vigila `test/anura-ui.test.ts`).

import { useRef, useState } from "react";
import { cn } from "@/components/ui";
import { Badge, CHECKBOX, FIELD, OpsButton } from "@/components/ops-ui";
import { CARD, CardHeader, EmptyRow, Field, HELP, ROW, RowList } from "@/components/settings-ui";
import {
  addAnuraPoolLine,
  removeAnuraPoolLine,
  setAnuraCaller,
  setAnuraExtensionActive,
} from "@/app/dashboard/[storeId]/settings/anura-actions";
import type { AnuraMutationResult, AnuraSettingsData } from "@/lib/anura/server";
import {
  ANURA_POOL_CHANNELS_QUESTION,
  ANURA_POOL_PANEL_STEPS,
  anuraFreeLinesLabel,
  anuraPoolLineBadge,
} from "@/lib/anura/pool";
import { defaultSipUser } from "@/lib/anura/sip";
import type { AnuraTabLock } from "@/lib/anura/sip-phone";
import { browserAnuraTabLock } from "@/lib/anura/jssip-client";
import { SipExtensionRow, draftOf } from "@/components/anura-kapta-phone-settings";

type Mutate = (action: () => Promise<AnuraMutationResult>) => void;

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

export function AnuraPoolLinesCard({
  storeId,
  data,
  pending,
  mutate,
  onChanged,
}: {
  storeId: string;
  data: AnuraSettingsData;
  pending: boolean;
  mutate: Mutate;
  onChanged: () => void;
}) {
  const [extension, setExtension] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);
  const lockRef = useRef<AnuraTabLock | null>(null);
  const lock = () => (lockRef.current ??= browserAnuraTabLock());
  const rejectedTests = useRef<Set<string>>(new Set()).current;

  if (data.poolMigrationMissing) {
    return (
      <div className={cn(CARD, "divide-y divide-line")}>
        <CardHeader title="Líneas compartidas (recomendado)" aside={<Badge tone="neutral">Sin migración</Badge>} />
        <p className={cn(ROW, HELP)}>Falta aplicar la migración 0313 en la base. Hasta entonces solo se llama con el anexo propio de cada persona.</p>
      </div>
    );
  }

  const lines = data.poolLines;
  const usable = lines.filter((l) => l.status === "libre" || l.status === "en_uso");
  const free = lines.filter((l) => l.status === "libre").length;
  const validExt = /^[0-9]{2,6}$/.test(extension.trim());
  const central = draftOf(data.sip);

  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title="Líneas compartidas (recomendado)"
        description={
          <>
            <span className="block">
              Unos pocos anexos de Anura para todo el equipo, en vez de uno por persona. Al pulsar «Llamar con Anura», Kapta le da a
              quien tiene «Puede llamar con Anura» una línea <strong>libre</strong> (primero la que menos se usó) y la suelta al
              colgar. Una línea nunca está en dos llamadas a la vez. Si todas están ocupadas, la ficha lo dice y se vuelve a intentar en
              un momento.
            </span>
            <span className="mt-1.5 block">
              Cada línea llama solo con el teléfono dentro de Kapta: necesita su clave de la «-websocket» guardada aquí. El historial
              del pedido y «Gestión por persona» siguen diciendo quién llamó; la línea solo dice por dónde salió.
            </span>
          </>
        }
        aside={
          <Badge tone={usable.length > 0 ? "ok" : "neutral"}>
            {lines.length === 0 ? "Sin líneas" : usable.length > 0 ? anuraFreeLinesLabel(free, usable.length) : `${lines.length} sin clave`}
          </Badge>
        }
      />

      <div className={cn(ROW, "space-y-2 text-sm leading-5 text-ink-700")}>
        <p className="font-medium text-ink-900">En el panel de Anura, por cada línea:</p>
        <ol className="list-decimal space-y-1 pl-6">
          {ANURA_POOL_PANEL_STEPS.map((step) => (
            <li key={step}>
              <WithCode text={step} />
            </li>
          ))}
        </ol>
        <p className={HELP}>{ANURA_POOL_CHANNELS_QUESTION}</p>
      </div>

      {!data.sip.domain && (
        <p className={cn(ROW, "text-sm text-warn-fg")}>
          Falta el dominio SIP de la central: guárdalo en «Teléfono dentro de Kapta» (abajo) antes de probar la clave de una línea.
        </p>
      )}

      {lines.length === 0 ? (
        <EmptyRow>Todavía no hay líneas compartidas. Suma la primera abajo (por ejemplo, 201).</EmptyRow>
      ) : (
        <RowList>
          {lines.map((line) => {
            const badge = anuraPoolLineBadge(line.status, line.inUseBy);
            const inUse = line.status === "en_uso";
            return (
              <SipExtensionRow
                key={`${line.id}:${line.extension}`}
                storeId={storeId}
                ext={line}
                pool
                title={
                  <>
                    Línea <span className="tabular-nums">{line.extension}</span>
                    <span className="font-normal text-ink-500"> · usuario SIP {line.phone.sipUser || defaultSipUser(line.extension)}</span>
                  </>
                }
                badge={badge}
                actions={
                  <>
                    <OpsButton
                      size="sm"
                      disabled={pending || testingId !== null}
                      onClick={() => mutate(() => setAnuraExtensionActive(storeId, line.id, !line.active))}
                      className="pointer-coarse:h-11"
                    >
                      {line.active ? "Apagar" : "Activar"}
                    </OpsButton>
                    <OpsButton
                      size="sm"
                      disabled={pending || testingId !== null || inUse}
                      title={inUse ? "Está en una llamada: quítala cuando termine" : undefined}
                      onClick={() => {
                        if (window.confirm(`¿Quitar la línea ${line.extension}? También se borra su clave de la «-websocket».`)) {
                          mutate(() => removeAnuraPoolLine(storeId, line.id));
                        }
                      }}
                      className="pointer-coarse:h-11"
                    >
                      Quitar línea
                    </OpsButton>
                  </>
                }
                central={central}
                pending={pending}
                testingId={testingId}
                setTestingId={setTestingId}
                lock={lock}
                rejectedTests={rejectedTests}
                mutate={mutate}
                onChanged={onChanged}
              />
            );
          })}
        </RowList>
      )}

      <form
        className={cn(ROW, "flex flex-wrap items-end gap-3")}
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!validExt) return;
          mutate(async () => {
            const res = await addAnuraPoolLine(storeId, extension.trim());
            if (res.ok) setExtension("");
            return res;
          });
        }}
      >
        <Field
          label="Sumar una línea (anexo)"
          htmlFor="anura-pool-ext"
          hint={validExt ? `Su usuario SIP será ${defaultSipUser(extension.trim())}.` : "De 2 a 6 dígitos."}
          className="w-56"
        >
          <input
            id="anura-pool-ext"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={extension}
            onChange={(e) => setExtension(e.target.value.replace(/\D/g, ""))}
            placeholder="201"
            className={cn(FIELD, "tabular-nums")}
          />
        </Field>
        <OpsButton type="submit" variant="primary" disabled={pending || !validExt} className="mb-[26px] pointer-coarse:h-11">
          Sumar línea
        </OpsButton>
      </form>
    </div>
  );
}

export function AnuraCallersCard({ storeId, data, pending, mutate }: { storeId: string; data: AnuraSettingsData; pending: boolean; mutate: Mutate }) {
  if (data.poolMigrationMissing) return null;
  const enabled = data.callers.filter((c) => c.enabled).length;
  return (
    <div className={cn(CARD, "divide-y divide-line")}>
      <CardHeader
        title="Quién puede llamar"
        description="Las personas que gestionan pedidos. Con «Puede llamar con Anura», a esa persona le sale «Llamar con Anura» en la ficha y toma una línea compartida libre al llamar. Quien tiene un anexo propio llama con él."
        aside={<Badge tone={enabled > 0 ? "ok" : "neutral"}>{enabled === 1 ? "1 persona" : `${enabled} personas`}</Badge>}
      />
      {data.callers.length === 0 ? (
        <EmptyRow>Nadie del equipo gestiona pedidos todavía.</EmptyRow>
      ) : (
        <RowList>
          {data.callers.map((c) => {
            const id = `anura-caller-${c.userId}`;
            return (
              <li key={c.userId} className={cn(ROW, "flex flex-wrap items-center justify-between gap-3")}>
                <label htmlFor={id} className="flex min-w-0 cursor-pointer items-center gap-3">
                  <input
                    id={id}
                    type="checkbox"
                    className={CHECKBOX}
                    checked={c.enabled}
                    disabled={pending}
                    onChange={(e) => {
                      const next = e.target.checked;
                      mutate(() => setAnuraCaller(storeId, c.userId, next));
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink-900">{c.name}</span>
                    <span className={cn(HELP, "block")}>Puede llamar con Anura</span>
                  </span>
                </label>
                {c.personalExtension && (
                  <span className={HELP}>
                    Llama con su anexo propio <span className="tabular-nums">{c.personalExtension}</span>
                  </span>
                )}
              </li>
            );
          })}
        </RowList>
      )}
    </div>
  );
}
