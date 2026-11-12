"use client";

// La página «Lista negra» (MOM §41 y §41.11, owner 09-11-2026). Todos los
// textos de la lista salen de lib/lista-negra-copy.ts.
//
//   * «Automática»: cuántos (devueltos / anuladores), cuándo se calculó, el
//     último envío a cada tienda, la búsqueda por UN celular (una server
//     action con tope por persona; la página nunca recibe la lista) con
//     «Exceptuar de la Lista negra», y las excepciones de Kapta enmascaradas
//     con «Quitar excepción».
//   * «Agregados a mano»: las altas a mano, cada una con lo que pide
//     («Adelanto de S/ 20» o «Pago total»), «Agregar a la Lista negra» y
//     «Sacar de la Lista negra», con motivo. Los sacados quedan como historia.

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { EmptyState, cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton } from "@/components/ops-ui";
import { CARD, HELP, ROW, TEXTAREA } from "@/components/settings-ui";
import { ListaNegraBadge } from "@/components/lista-negra-badge";
import { ExceptControl } from "@/components/pago-online-banner";
import type { PrepayEntryView, PrepayOrgView } from "@/lib/prepay-list-access";
import { PREPAY_ENTRY_REQUIREMENTS, PREPAY_REASON_MIN, prepayEntryMotivo, type PrepayEntryRequirement } from "@/lib/prepay-list";
import { PAGO_ONLINE_MODE_LABEL, PAGO_ONLINE_REASON_MIN } from "@/lib/pago-online";
import type { ListaNegraSearchView } from "@/lib/lista-negra";
import {
  LN_EMPTY_EXCEPTIONS,
  LN_EMPTY_MANUAL,
  LN_EXCEPTION_REMOVE,
  LN_FOOTNOTE,
  LN_MANUAL_ADD_BUTTON,
  LN_MANUAL_REMOVE,
  LN_MANUAL_REQUIREMENT_LABEL,
  LN_NAME,
  LN_PAGE_SUBTITLE,
  LN_REQUIREMENT_LABEL,
  LN_SEARCH_LABEL,
  LN_SEARCH_NOT_LISTED,
  LN_SEARCH_PLACEHOLDER,
  LN_SECTION_AUTO,
  LN_SECTION_AUTO_HELP,
  LN_SECTION_MANUAL,
  LN_SECTION_MANUAL_HELP,
  lnRequisito,
  lnSearchExcepted,
  lnSearchListed,
} from "@/lib/lista-negra-copy";
import {
  addToPrepayList,
  exceptFromListaNegra,
  removeFromPrepayList,
  removeListaNegraException,
  searchListaNegraAction,
  type PrepayListActionResult,
} from "@/app/dashboard/clientes/lista-negra/actions";

type Status = { kind: "ok" | "error"; text: string } | null;

const NETWORK_ERROR = "No se pudo guardar. Revisa la conexión y vuelve a intentar.";
const fmtInt = (n: number) => n.toLocaleString("es-PE");

function statusOf(result: PrepayListActionResult): Status {
  return result.error ? { kind: "error", text: result.error } : { kind: "ok", text: result.notice ?? "Guardado" };
}

export function ListaNegraPage({ orgs, writable }: { orgs: PrepayOrgView[]; writable: boolean }) {
  const [orgId, setOrgId] = useState(orgs[0]?.orgId ?? "");
  const org = orgs.find((o) => o.orgId === orgId) ?? orgs[0];
  if (!org) return <EmptyState title="Sin organización">No perteneces a ninguna organización.</EmptyState>;
  const canEdit = writable && org.canManage;

  return (
    <div className="mx-auto max-w-[76rem]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">{LN_NAME}</h1>
          <p className="mt-1 max-w-[72ch] text-sm text-ink-500">{LN_PAGE_SUBTITLE}</p>
        </div>
        {orgs.length > 1 && (
          <label className="flex items-center gap-2 text-[13px] font-medium text-ink-600">
            Organización
            <select
              value={org.orgId}
              onChange={(e) => setOrgId(e.target.value)}
              className="block h-9 rounded-md border-0 bg-white px-3 text-sm text-ink-900 shadow-control ring-1 ring-inset ring-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 pointer-coarse:h-11"
            >
              {orgs.map((o) => (
                <option key={o.orgId} value={o.orgId}>
                  {o.orgName}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {!writable && (
        <Banner tone="info" role="status" className="mt-6" title="Solo lectura en este entorno">
          Los cambios se guardan solo en producción.
        </Banner>
      )}
      {writable && !org.canManage && (
        <Banner tone="info" role="status" className="mt-6" title="Solo lectura">
          Agregar, sacar y exceptuar es del dueño y de los admin («Gestionar la Lista negra»).
        </Banner>
      )}
      {org.error && (
        <Banner tone="warn" role="status" className="mt-4">
          {org.error}
        </Banner>
      )}

      {/* La clave remonta todo al cambiar de organización: nada de un resultado de otra. */}
      <div key={org.orgId} className="mt-8 space-y-10">
        <AutomaticSection org={org} canEdit={canEdit} />
        <ManualSection org={org} canEdit={canEdit} />
      </div>
      <p className="mt-8 text-xs text-ink-500">{LN_FOOTNOTE}</p>
    </div>
  );
}

// ── Automática ──────────────────────────────────────────────────────────────

function AutomaticSection({ org, canEdit }: { org: PrepayOrgView; canEdit: boolean }) {
  const a = org.automatic;
  const devueltos = a.current ? Math.max(0, a.current.phones - a.current.anuladores - a.current.rechazos) : 0;
  return (
    <section aria-labelledby="ln-auto" className="space-y-4">
      <div>
        <h2 id="ln-auto" className="text-base font-semibold text-ink-900">
          {LN_SECTION_AUTO}{" "}
          <Badge tone={a.mode === "activo" ? "ok" : a.mode === "simulacion" ? "info" : "neutral"}>{PAGO_ONLINE_MODE_LABEL[a.mode]}</Badge>
        </h2>
        <p className={cn(HELP, "mt-1 max-w-[72ch]")}>{LN_SECTION_AUTO_HELP}</p>
      </div>
      {a.error && (
        <Banner tone="warn" role="status">
          {a.error}
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className={cn(CARD, ROW, "py-3")}>
          <p className="text-xs font-semibold text-ink-500">En la lista</p>
          <p className="text-[20px] font-semibold tabular-nums leading-7 text-ink-900">{a.current ? fmtInt(a.current.phones) : "—"}</p>
          {a.current && (
            <p className={HELP}>
              {fmtInt(devueltos)} devolvieron · {fmtInt(a.current.rechazos)} rechazaron en la puerta · {fmtInt(a.current.anuladores)} anulan casi todo
            </p>
          )}
        </div>
        <div className={cn(CARD, ROW, "py-3")}>
          <p className="text-xs font-semibold text-ink-500">Calculada</p>
          <p className="text-sm font-medium text-ink-900">{a.current?.at ?? a.lastRun?.at ?? "Todavía no"}</p>
          <p className={HELP}>Se pide: {LN_REQUIREMENT_LABEL[a.requirement]}</p>
        </div>
        <div className={cn(CARD, ROW, "py-3")}>
          <p className="text-xs font-semibold text-ink-500">Último envío a cada tienda</p>
          {a.stores.length === 0 ? (
            <p className={HELP}>Sin tiendas WooCommerce activas.</p>
          ) : (
            <ul className="mt-0.5 space-y-0.5 text-[13px] text-ink-700">
              {a.stores.map((s) => (
                <li key={s.id}>
                  <span className="font-medium text-ink-900">{s.name}:</span>{" "}
                  {s.lastOk ? `${s.lastOk.at} · ${fmtInt(s.lastOk.phones)}` : "sin envío bueno"}
                  {s.lastError ? <span className="text-crit-fg"> · {s.lastError.status}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className={HELP}>
        El envío a las tiendas lleva también los agregados a mano. La posición, el cobro y los envíos se manejan en{" "}
        <Link href="/dashboard/automatizaciones#pago-online-posicion" className="font-medium text-brand-700 hover:underline">
          Automatizaciones
        </Link>
        .
      </p>

      <SearchBox orgId={org.orgId} canEdit={canEdit} />

      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-ink-900">
          Excepciones de Kapta <Badge>{fmtInt(a.exceptions.length)}</Badge>
        </h3>
        {a.exceptions.length === 0 ? (
          <p className={cn(CARD, ROW, "text-sm text-ink-500")}>{LN_EMPTY_EXCEPTIONS}</p>
        ) : (
          <ul className={cn(CARD, "divide-y divide-line")}>
            {a.exceptions.map((e) => (
              <li key={e.id} className={cn(ROW, "py-3")}>
                <p className="text-sm text-ink-900">
                  <span className="tabular-nums">{e.phoneMasked}</span>
                  {e.orderName ? ` · ${e.orderName}` : ""}
                </p>
                <p className={HELP}>
                  {e.reason} · {e.addedBy} · {e.addedAt}
                </p>
                {canEdit && <ReasonAction label={LN_EXCEPTION_REMOVE} min={PAGO_ONLINE_REASON_MIN} run={(reason) => removeListaNegraException(org.orgId, e.id, reason)} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SearchBox({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const id = useId();
  const [phone, setPhone] = useState("");
  const [asked, setAsked] = useState("");
  const [result, setResult] = useState<{ error?: string; view?: ListaNegraSearchView } | null>(null);
  const [pending, startTransition] = useTransition();
  const v = result?.view;
  return (
    <div className={cn(CARD, ROW, "space-y-3 py-4")}>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (pending || !phone.trim()) return;
          setResult(null);
          const typed = phone;
          startTransition(async () => {
            try {
              setResult(await searchListaNegraAction(orgId, typed));
              setAsked(typed);
            } catch {
              setResult({ error: "No se pudo buscar. Revisa la conexión y vuelve a intentar." });
            }
          });
        }}
      >
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="text-[13px] font-medium text-ink-700">
            {LN_SEARCH_LABEL}
          </label>
          <input
            id={id}
            type="search"
            inputMode="tel"
            autoComplete="off"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={LN_SEARCH_PLACEHOLDER}
            className={cn(FIELD, "mt-1.5 w-full sm:w-64 pointer-coarse:h-11")}
          />
        </div>
        <OpsButton type="submit" disabled={pending || !phone.trim()} className="pointer-coarse:h-11">
          {pending ? "Buscando…" : "Buscar"}
        </OpsButton>
      </form>

      <div aria-live="polite" className="empty:hidden">
        {result?.error && <p className="text-[13px] text-crit-fg">{result.error}</p>}
        {v && (
          <div className="space-y-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold tabular-nums text-ink-900">{v.phoneLabel}</span>
              {v.mark && <ListaNegraBadge mark={v.mark} />}
            </div>
            <p className="text-sm text-ink-900">{v.mark ? lnSearchListed(v.mark.motivo) : LN_SEARCH_NOT_LISTED}</p>
            {v.mark && <p className="text-[13px] text-ink-700">{lnRequisito(v.mark.requirement)}</p>}
            {v.manual && v.automatic?.braking && (
              <p className={HELP}>También en la automática: {v.automatic.motivo}.</p>
            )}
            {v.manual && <p className={HELP}>Agregada el {v.manual.addedAt} por {v.manual.addedBy} · se pide: {v.manual.requirementLabel}</p>}
            {v.exception && (
              <p className="text-[13px] text-ink-700">
                {lnSearchExcepted(v.exception.reason)}
                <span className="text-ink-500">
                  {" "}
                  · {v.exception.addedBy} · {v.exception.addedAt}
                  {v.automatic ? ` · en la automática: ${v.automatic.motivo}` : ""}
                </span>
              </p>
            )}
            {!v.automatic && v.automaticNote && <p className={HELP}>{v.automaticNote}</p>}
            {v.orders.length > 0 && (
              <p className="text-[13px] text-ink-700">
                Pedidos recientes:{" "}
                {v.orders.map((o, i) => (
                  <span key={o.id}>
                    {i > 0 && ", "}
                    <Link href={`/dashboard/pedidos?abrir=${o.id}`} className="font-medium text-brand-700 hover:underline">
                      {o.name}
                    </Link>
                  </span>
                ))}
              </p>
            )}
            {v.canExcept && <ExceptControl canEdit={canEdit} onExcept={(reason) => exceptFromListaNegra(orgId, asked, reason)} />}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Agregados a mano ────────────────────────────────────────────────────────

function ManualSection({ org, canEdit }: { org: PrepayOrgView; canEdit: boolean }) {
  return (
    <section aria-labelledby="ln-manual" className="space-y-4">
      <div>
        <h2 id="ln-manual" className="text-base font-semibold text-ink-900">
          {LN_SECTION_MANUAL} <Badge>{fmtInt(org.active.length)}</Badge>
        </h2>
        <p className={cn(HELP, "mt-1 max-w-[72ch]")}>{LN_SECTION_MANUAL_HELP}</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-3">
          <EntryList entries={org.active} orgId={org.orgId} canEdit={canEdit} empty={LN_EMPTY_MANUAL} />
          {org.removed.length > 0 && (
            <details className="pt-2">
              <summary className="cursor-pointer text-sm font-semibold text-ink-900">
                Sacados <Badge>{fmtInt(org.removed.length)}</Badge>
              </summary>
              <p className={cn(HELP, "my-2")}>La historia no se borra.</p>
              <EntryList entries={org.removed} orgId={org.orgId} canEdit={false} empty="" />
            </details>
          )}
        </div>
        <aside className="space-y-3">
          <h3 className="text-sm font-semibold text-ink-900">{LN_MANUAL_ADD_BUTTON}</h3>
          <AddForm orgId={org.orgId} canEdit={canEdit} />
        </aside>
      </div>
    </section>
  );
}

function EntryList({ entries, orgId, canEdit, empty }: { entries: PrepayEntryView[]; orgId: string; canEdit: boolean; empty: string }) {
  if (!entries.length) return empty ? <p className={cn(CARD, ROW, "text-sm text-ink-500")}>{empty}</p> : null;
  return (
    <ul className={cn(CARD, "divide-y divide-line")}>
      {entries.map((e) => (
        <li key={e.id} className={cn(ROW, "py-3")}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm font-semibold tabular-nums text-ink-900">{e.phoneLabel}</span>
            {!e.removedAt && <ListaNegraBadge mark={{ motivo: prepayEntryMotivo(e.reason), requirement: e.requirement }} />}
            {e.lastOrderName &&
              (e.lastOrderId ? (
                <Link href={`/dashboard/pedidos?abrir=${e.lastOrderId}`} className="text-[13px] font-medium text-brand-700 hover:underline">
                  {e.lastOrderName}
                </Link>
              ) : (
                <span className="text-[13px] text-ink-600">{e.lastOrderName}</span>
              ))}
          </div>
          <p className="mt-1 text-[13px] leading-5 text-ink-700">{prepayEntryMotivo(e.reason)}</p>
          <p className={cn(HELP, "mt-0.5")}>
            {lnRequisito(e.requirement)} · agregada el {e.addedAt} por {e.addedBy}
            {e.removedAt ? ` · sacada el ${e.removedAt} por ${e.removedBy}: «${e.removedReason}»` : ""}
          </p>
          {canEdit && !e.removedAt && <ReasonAction label={LN_MANUAL_REMOVE} min={PREPAY_REASON_MIN} run={(reason) => removeFromPrepayList(orgId, e.id, reason)} />}
        </li>
      ))}
    </ul>
  );
}

/** Un botón que pide el motivo antes de hacer algo («Sacar de la Lista negra», «Quitar excepción»). */
function ReasonAction({ label, min, run }: { label: string; min: number; run: (reason: string) => Promise<PrepayListActionResult> }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [pending, startTransition] = useTransition();
  if (!open) {
    return (
      <OpsButton size="sm" className="mt-2 pointer-coarse:h-11" onClick={() => setOpen(true)}>
        {label}
      </OpsButton>
    );
  }
  return (
    <form
      className="mt-2 space-y-2"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (pending) return;
        setStatus(null);
        startTransition(async () => {
          try {
            setStatus(statusOf(await run(reason)));
          } catch {
            setStatus({ kind: "error", text: NETWORK_ERROR });
          }
        });
      }}
    >
      <label htmlFor={id} className="text-[13px] font-medium text-ink-700">
        Motivo (al menos {min} caracteres)
      </label>
      <textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={TEXTAREA} />
      <div className="flex flex-wrap items-center gap-2">
        <OpsButton type="submit" size="sm" variant="primary" disabled={pending || reason.trim().length < min}>
          {pending ? "Guardando…" : label}
        </OpsButton>
        <OpsButton size="sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancelar
        </OpsButton>
        <span aria-live="polite" className={cn("text-[13px]", status?.kind === "error" ? "text-crit-fg" : "text-ok-fg")}>
          {status?.text}
        </span>
      </div>
    </form>
  );
}

function AddForm({ orgId, canEdit }: { orgId: string; canEdit: boolean }) {
  const phoneId = useId();
  const reasonId = useId();
  const reqId = useId();
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
  const [requirement, setRequirement] = useState<PrepayEntryRequirement>("pago_completo");
  const [status, setStatus] = useState<Status>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className={cn(CARD, ROW, "space-y-3")}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!canEdit || pending) return;
        setStatus(null);
        startTransition(async () => {
          try {
            const result = await addToPrepayList(orgId, phone, reason, requirement);
            setStatus(statusOf(result));
            if (!result.error) {
              setPhone("");
              setReason("");
            }
          } catch {
            setStatus({ kind: "error", text: NETWORK_ERROR });
          }
        });
      }}
    >
      <div>
        <label htmlFor={phoneId} className="text-[13px] font-medium text-ink-700">
          Celular
        </label>
        <input
          id={phoneId}
          inputMode="tel"
          autoComplete="off"
          value={phone}
          disabled={!canEdit}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={LN_SEARCH_PLACEHOLDER}
          className={cn(FIELD, "mt-1.5 pointer-coarse:h-11")}
        />
      </div>
      <div>
        <label htmlFor={reqId} className="text-[13px] font-medium text-ink-700">
          {LN_MANUAL_REQUIREMENT_LABEL}
        </label>
        <select
          id={reqId}
          value={requirement}
          disabled={!canEdit}
          onChange={(e) => setRequirement(e.target.value as PrepayEntryRequirement)}
          className={cn(FIELD, "mt-1.5 pointer-coarse:h-11")}
        >
          {PREPAY_ENTRY_REQUIREMENTS.map((r) => (
            <option key={r} value={r}>
              {LN_REQUIREMENT_LABEL[r]}
            </option>
          ))}
        </select>
        <p className={cn(HELP, "mt-1")}>{lnRequisito(requirement)}</p>
      </div>
      <div>
        <label htmlFor={reasonId} className="text-[13px] font-medium text-ink-700">
          Motivo
        </label>
        <textarea
          id={reasonId}
          rows={3}
          value={reason}
          disabled={!canEdit}
          onChange={(e) => setReason(e.target.value)}
          className={cn(TEXTAREA, "mt-1.5")}
        />
        <p className={cn(HELP, "mt-1")}>Al menos {PREPAY_REASON_MIN} caracteres. Queda con tu nombre y la fecha.</p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span aria-live="polite" className={cn("text-[13px]", status?.kind === "error" ? "text-crit-fg" : "text-ok-fg")}>
          {status?.text}
        </span>
        <OpsButton type="submit" variant="primary" disabled={!canEdit || pending || !phone.trim() || reason.trim().length < PREPAY_REASON_MIN}>
          {pending ? "Agregando…" : LN_MANUAL_ADD_BUTTON}
        </OpsButton>
      </div>
    </form>
  );
}
