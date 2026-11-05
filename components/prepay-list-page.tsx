"use client";

// «Lista de pago adelantado» (MOM §41): los celulares que pagan el total por
// adelantado, por organización. Activos arriba, con su último pedido, si los
// agregó la regla o una persona, el motivo, cuándo y quién; debajo, los que se
// quitaron (la historia no se borra). Buscar por celular, «Agregar» (celular +
// motivo) y «Quitar» (motivo) para quien tiene `prepay_list.manage`.

import Link from "next/link";
import { useId, useState, useTransition } from "react";
import { EmptyState, cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton } from "@/components/ops-ui";
import { CARD, HELP, ROW, TEXTAREA } from "@/components/settings-ui";
import type { PrepayEntryView, PrepayOrgView } from "@/lib/prepay-list-access";
import { PREPAY_LIST_LABEL, PREPAY_LIST_SYNONYM, PREPAY_REASON_MIN, PREPAY_TRIGGER_LABEL, prepaySourceLabel } from "@/lib/prepay-list";
import { addToPrepayList, removeFromPrepayList, type PrepayListActionResult } from "@/app/dashboard/clientes/pago-adelantado/actions";

type Status = { kind: "ok" | "error"; text: string } | null;

const NETWORK_ERROR = "No se pudo guardar. Revisa la conexión y vuelve a intentar.";

function statusOf(result: PrepayListActionResult): Status {
  return result.error ? { kind: "error", text: result.error } : { kind: "ok", text: result.notice ?? "Guardado" };
}

const digits = (s: string) => s.replace(/\D+/g, "");

export function PrepayListPage({ orgs, writable }: { orgs: PrepayOrgView[]; writable: boolean }) {
  const [orgId, setOrgId] = useState(orgs[0]?.orgId ?? "");
  const [query, setQuery] = useState("");
  const org = orgs.find((o) => o.orgId === orgId) ?? orgs[0];
  const q = digits(query);
  const match = (e: PrepayEntryView) => !q || e.phone.includes(q) || e.phone.slice(2).includes(q);
  const active = org ? org.active.filter(match) : [];
  const removed = org ? org.removed.filter(match) : [];
  if (!org) return <EmptyState title="Sin organización">No perteneces a ninguna organización.</EmptyState>;
  const canEdit = writable && org.canManage;

  return (
    <div className="mx-auto max-w-[76rem]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">{PREPAY_LIST_LABEL}</h1>
          <p className="mt-1 max-w-[72ch] text-sm text-ink-500">
            La {PREPAY_LIST_SYNONYM}: estos celulares pagan el total por adelantado, sin contra entrega. Kapta no los confirma ni les crea guía
            hasta que el pago total esté validado, y la tienda les esconde el «Pago contra entrega». Entra quien rechazó un pedido en la puerta o
            no lo recogió en la agencia; también se agrega y se quita a mano, con motivo.
          </p>
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
          Agregar y quitar clientes es del dueño y de los admin («Gestionar la lista de pago adelantado»).
        </Banner>
      )}
      {org.error && (
        <Banner tone="warn" role="status" className="mt-4">
          {org.error}
        </Banner>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby="prepay-activos" className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="prepay-activos" className="text-base font-semibold text-ink-900">
              En la lista <Badge>{org.active.length.toLocaleString("es-PE")}</Badge>
            </h2>
            <input
              type="search"
              inputMode="tel"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por celular"
              aria-label="Buscar por celular"
              className={cn(FIELD, "w-full sm:w-64 pointer-coarse:h-11")}
            />
          </div>
          <EntryList entries={active} orgId={org.orgId} canEdit={canEdit} empty={q ? "Ningún celular de la lista coincide." : "La lista está vacía."} />

          <h2 className="pt-4 text-base font-semibold text-ink-900">
            Quitados <Badge>{org.removed.length.toLocaleString("es-PE")}</Badge>
          </h2>
          <p className={HELP}>
            La historia no se borra. A quien se quitó a mano, la regla automática solo lo vuelve a agregar si rechaza o no recoge un pedido que
            no tenía ya al quitarlo.
          </p>
          <EntryList entries={removed} orgId={org.orgId} canEdit={false} empty={q ? "Ningún quitado coincide." : "Nadie se ha quitado todavía."} />
        </section>

        <aside className="space-y-3">
          <h2 className="text-base font-semibold text-ink-900">Agregar a mano</h2>
          <AddForm key={org.orgId} orgId={org.orgId} canEdit={canEdit} />
        </aside>
      </div>
    </div>
  );
}

function EvidenceLine({ entry }: { entry: PrepayEntryView }) {
  if (entry.evidence.kind !== "auto" || !entry.evidence.orders.length) return null;
  return (
    <p className={cn(HELP, "mt-0.5")}>
      {entry.evidence.orders
        .slice(0, 4)
        .map((o) => `${o.order_name ?? "Pedido"} · ${PREPAY_TRIGGER_LABEL[o.kind]}`)
        .join(" — ")}
      {entry.evidence.orders.length > 4 ? " …" : ""}
    </p>
  );
}

function EntryList({ entries, orgId, canEdit, empty }: { entries: PrepayEntryView[]; orgId: string; canEdit: boolean; empty: string }) {
  if (!entries.length) return <p className={cn(CARD, ROW, "text-sm text-ink-500")}>{empty}</p>;
  return (
    <ul className={cn(CARD, "divide-y divide-line")}>
      {entries.map((e) => (
        <li key={e.id} className={cn(ROW, "py-3")}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm font-semibold tabular-nums text-ink-900">{e.phoneLabel}</span>
            <Badge tone={e.source === "auto" ? "info" : "neutral"}>{prepaySourceLabel(e.source)}</Badge>
            {e.lastOrderName &&
              (e.lastOrderId ? (
                <Link href={`/dashboard/pedidos?abrir=${e.lastOrderId}`} className="text-[13px] font-medium text-brand-700 hover:underline">
                  {e.lastOrderName}
                </Link>
              ) : (
                <span className="text-[13px] text-ink-600">{e.lastOrderName}</span>
              ))}
          </div>
          <p className="mt-1 text-[13px] leading-5 text-ink-700">{e.reason}</p>
          <EvidenceLine entry={e} />
          <p className={cn(HELP, "mt-0.5")}>
            Agregado el {e.addedAt} por {e.addedBy}
            {e.removedAt ? ` · quitado el ${e.removedAt} por ${e.removedBy}: «${e.removedReason}»` : ""}
          </p>
          {canEdit && !e.removedAt && <RemoveControl orgId={orgId} entry={e} />}
        </li>
      ))}
    </ul>
  );
}

function RemoveControl({ orgId, entry }: { orgId: string; entry: PrepayEntryView }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [pending, startTransition] = useTransition();
  if (!open) {
    return (
      <OpsButton size="sm" className="mt-2 pointer-coarse:h-11" onClick={() => setOpen(true)}>
        Quitar
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
            setStatus(statusOf(await removeFromPrepayList(orgId, entry.id, reason)));
          } catch {
            setStatus({ kind: "error", text: NETWORK_ERROR });
          }
        });
      }}
    >
      <label htmlFor={id} className="text-[13px] font-medium text-ink-700">
        Por qué se quita (al menos {PREPAY_REASON_MIN} caracteres)
      </label>
      <textarea id={id} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={TEXTAREA} />
      <div className="flex flex-wrap items-center gap-2">
        <OpsButton type="submit" size="sm" variant="primary" disabled={pending || reason.trim().length < PREPAY_REASON_MIN}>
          {pending ? "Quitando…" : "Quitar de la lista"}
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
  const [phone, setPhone] = useState("");
  const [reason, setReason] = useState("");
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
            const result = await addToPrepayList(orgId, phone, reason);
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
          placeholder="987 654 321"
          className={cn(FIELD, "mt-1.5 pointer-coarse:h-11")}
        />
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
          {pending ? "Agregando…" : "Agregar"}
        </OpsButton>
      </div>
    </form>
  );
}
