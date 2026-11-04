"use client";

// Manifiestos de devolución (0307, MOM §9.4 y §29.13; owner 04-11-2026): la
// pestaña «Manifiestos» de Devoluciones y el botón «Nuevo manifiesto de
// devolución» (también en Despacho del día). Cuando Alexis trae de golpe lo de
// varios días, almacén abre uno, escanea caja por caja y lo cierra con lo que
// faltó. Permiso de Almacén (`warehouse.prepare`).

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton, SECTION_CARD, SectionHead } from "@/components/ops-ui";
import { IconAlert, IconChevronRight, IconPlus, IconUndo } from "@/components/icons";
import { openReturnManifest } from "@/app/dashboard/pedidos/devoluciones/manifest-actions";
import { boxDayShort } from "@/lib/gf-scan-return";
import {
  RETURN_MANIFEST_STATE_LABEL,
  RETURN_MANIFESTS_PATH,
  RETURN_MANIFESTS_TAB_PATH,
  returnManifestPath,
  STALE_OPEN_MANIFEST_DAYS,
  type ReturnManifestState,
} from "@/lib/return-manifest";
import type { ReturnManifestListItem, ReturnManifestRiderOption } from "@/lib/return-manifest-access";

/** El tono del estado de la cabecera. */
export const RETURN_MANIFEST_STATE_TONE: Record<ReturnManifestState, "info" | "neutral" | "warn"> = {
  open: "info",
  closed: "neutral",
  cancelled: "warn",
};

/** Hoy en Lima (YYYY-MM-DD): el tope del «Llegó el». */
function limaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** «04/11 15:20», hora de Lima. */
export function limaShortDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")}`;
}

/** Las dos pestañas de Devoluciones, con el mismo control segmentado de Despacho del día. */
export function ReturnsTabs({ active }: { active: "recepcion" | "manifiestos" }) {
  const tab = (id: "recepcion" | "manifiestos", href: string, label: string) => (
    <Link
      href={href}
      role="tab"
      aria-selected={active === id}
      className={cn(
        "flex h-9 min-w-0 items-center justify-center rounded-md px-4 text-sm font-semibold transition-[background-color,color,box-shadow] duration-150",
        active === id ? "bg-white text-ink-900 shadow-control ring-1 ring-line" : "text-ink-500 hover:text-ink-900",
      )}
    >
      {label}
    </Link>
  );
  return (
    <div role="tablist" aria-label="Devoluciones" className="mt-4 inline-grid grid-cols-2 gap-0.5 rounded-lg bg-wash p-0.5 ring-1 ring-inset ring-line">
      {tab("recepcion", RETURN_MANIFESTS_PATH, "Recepción")}
      {tab("manifiestos", RETURN_MANIFESTS_TAB_PATH, "Manifiestos")}
    </div>
  );
}

/**
 * Abrir (o seguir) el manifiesto de un motorizado. Uno abierto por motorizado:
 * si ya hay uno, se va a ese.
 */
export function useOpenReturnManifest() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function open(riderId: string, arrivedOn?: string | null) {
    if (!riderId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await openReturnManifest({ riderId, arrivedOn: arrivedOn || null });
      if (!res.ok || !res.manifestId) { setError(res.error ?? "No se pudo abrir el manifiesto."); return; }
      router.push(returnManifestPath(res.manifestId));
    } catch {
      setError("No se pudo abrir el manifiesto. Reintenta.");
    } finally {
      setBusy(false);
    }
  }
  return { open, busy, error };
}

/** «Alexis · 12 No entregado · 3 fuera de plazo». */
function riderOptionLabel(r: ReturnManifestRiderOption): string {
  const parts = [r.riderName, `${r.expected} No entregado`];
  if (r.outOfCadence) parts.push(`${r.outOfCadence} fuera de plazo`);
  if (r.openManifestId) parts.push("manifiesto abierto");
  return parts.join(" · ");
}

/** El formulario «Nuevo manifiesto de devolución»: courier, motorizado y día de llegada. */
function NewReturnManifest({ riders, preselectRiderId }: { riders: ReturnManifestRiderOption[]; preselectRiderId: string | null }) {
  const today = limaToday();
  const [riderId, setRiderId] = useState(() => (preselectRiderId && riders.some((r) => r.riderId === preselectRiderId) ? preselectRiderId : ""));
  const [arrivedOn, setArrivedOn] = useState(today);
  const { open, busy, error } = useOpenReturnManifest();
  const rider = riders.find((r) => r.riderId === riderId) ?? null;
  return (
    <section aria-labelledby="nuevo-manifiesto" className={SECTION_CARD}>
      <SectionHead
        id="nuevo-manifiesto"
        title="Nuevo manifiesto de devolución"
        help="Para cuando el motorizado trae de golpe lo de varios días. Kapta sabe qué debería volver —cada «No entregado» que sigue en sus cajas— y lo coteja con lo que escaneas."
      />
      <form
        className="mt-4 grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)_11rem_auto] sm:items-end"
        onSubmit={(e) => { e.preventDefault(); void open(riderId, arrivedOn); }}
      >
        <label className="grid gap-1.5">
          <span className="text-[13px] font-medium text-ink-700">Courier</span>
          {/* Fase 1: solo Grupo GF. Urpi llega en la fase 2. */}
          <select value="propio" disabled className={cn(FIELD, "font-medium")} aria-describedby="nuevo-manifiesto-courier">
            <option value="propio">Grupo GF</option>
          </select>
        </label>
        <label className="grid min-w-0 gap-1.5">
          <span className="text-[13px] font-medium text-ink-700">Motorizado</span>
          <select value={riderId} onChange={(e) => setRiderId(e.target.value)} className={cn(FIELD, "font-medium")} required>
            <option value="">¿Quién trae las devoluciones?</option>
            {riders.map((r) => <option key={r.riderId} value={r.riderId}>{riderOptionLabel(r)}</option>)}
          </select>
        </label>
        <label className="grid gap-1.5">
          <span className="text-[13px] font-medium text-ink-700">Llegó el</span>
          <input type="date" value={arrivedOn} max={today} onChange={(e) => setArrivedOn(e.target.value)} className={cn(FIELD, "tabular-nums")} />
        </label>
        <OpsButton type="submit" variant="primary" className="h-9" disabled={busy || !riderId}>
          {busy ? "Abriendo…" : rider?.openManifestId ? "Seguir el abierto" : "Abrir manifiesto"}
        </OpsButton>
      </form>
      <p id="nuevo-manifiesto-courier" className="mt-2 text-xs text-ink-500">
        {rider
          ? `Plazo de ${rider.riderName.split(/\s+/)[0]}: ${rider.cadenceDays} ${rider.cadenceDays === 1 ? "día" : "días"} desde el día de la caja; después, lo que no traiga figura como «Falta». Un reprogramado sigue con él hasta 14 días.`
          : "Solo Grupo GF por ahora. Uno abierto por motorizado: si ya tiene uno, se sigue ese."}
      </p>
      {error && <Banner tone="crit" role="alert" className="mt-3">{error}</Banner>}
      {!riders.length && <p className="mt-3 text-[13px] text-ink-500">No hay motorizados activos de Grupo GF en tu organización.</p>}
    </section>
  );
}

/**
 * Despacho del día, tarjeta «Devoluciones»: un botón por motorizado con «No
 * entregado» en sus cajas. Solo lo ve quien tiene el permiso de Almacén (el
 * servidor no le manda motorizados a quien no lo tiene).
 */
export function ReturnManifestRiderButtons({ riders }: { riders: ReturnManifestRiderOption[] }) {
  const { open, busy, error } = useOpenReturnManifest();
  const withReturns = riders.filter((r) => r.expected > 0 || r.openManifestId);
  if (!withReturns.length) return null;
  return (
    <div className="rounded-lg bg-wash px-3 py-2.5 ring-1 ring-inset ring-line">
      <p className="text-[13px] font-medium text-ink-700">¿Trae lo de varios días? Ábrele un manifiesto de devolución y queda el registro de lo que llegó y lo que falta.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {withReturns.map((r) => (
          <OpsButton key={r.riderId} size="sm" disabled={busy} onClick={() => void open(r.riderId)} title={riderOptionLabel(r)}>
            <IconUndo aria-hidden className="text-ink-500" />
            {r.openManifestId ? `Seguir manifiesto · ${r.riderName.split(/\s+/)[0]}` : `Nuevo manifiesto de devolución · ${r.riderName.split(/\s+/)[0]}`}
            <Badge tone={r.outOfCadence ? "warn" : "neutral"} className="tabular-nums">{r.expected}</Badge>
          </OpsButton>
        ))}
      </div>
      {error && <Banner tone="crit" role="alert" className="mt-2">{error}</Banner>}
    </div>
  );
}

function Count({ value, tone }: { value: number; tone?: "ok" | "warn" | "crit" }) {
  if (!value) return <span className="tabular-nums text-ink-500">0</span>;
  return <span className={cn("font-semibold tabular-nums", tone === "ok" ? "text-ok-fg" : tone === "warn" ? "text-warn-fg" : tone === "crit" ? "text-crit-fg" : "text-ink-900")}>{value}</span>;
}

/** La pestaña «Manifiestos»: abiertos primero, luego cerrados por día de llegada. */
export function ReturnManifestList({ tabs, manifests, loadError, riders, preselectRiderId }: {
  tabs: ReactNode;
  manifests: ReturnManifestListItem[];
  loadError: string | null;
  riders: ReturnManifestRiderOption[];
  preselectRiderId: string | null;
}) {
  const stale = manifests.filter((m) => m.stale);
  return (
    <div className="mx-auto max-w-[1500px] space-y-5 pb-24">
      <header>
        <Link href="/dashboard/pedidos/almacen" className="text-[13px] font-medium text-ink-500 hover:text-ink-900">← Almacén</Link>
        <h1 className="mt-1 text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Devoluciones</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-500">
          Un manifiesto por cada entrega de devoluciones de un motorizado de Grupo GF: lo que llegó, lo que se esperaba y no llegó, y lo que llegó sin esperarse. Cada caja se recibe con la recepción de siempre.
        </p>
        {tabs}
      </header>

      {loadError && (
        <Banner tone="crit" role="alert" title="No se pudieron leer los manifiestos">
          <span className="block text-xs text-ink-500">{loadError}</span>
        </Banner>
      )}
      {stale.length > 0 && (
        <Banner tone="warn" role="status" title={`${stale.length} ${stale.length === 1 ? "manifiesto abierto" : "manifiestos abiertos"} hace más de ${STALE_OPEN_MANIFEST_DAYS === 1 ? "un día" : `${STALE_OPEN_MANIFEST_DAYS} días`}`}>
          Ciérralo cuando termines de escanear, o anúlalo si se abrió por error: abierto, lo que faltó no queda anotado.
        </Banner>
      )}

      <NewReturnManifest riders={riders} preselectRiderId={preselectRiderId} />

      <section aria-labelledby="lista-manifiestos" className="rounded-lg bg-white shadow-control ring-1 ring-line">
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pt-4 sm:px-5">
          <h2 id="lista-manifiestos" className="text-base font-semibold leading-6 text-ink-900">Manifiestos</h2>
          <Badge className="tabular-nums">{manifests.length}</Badge>
          <p className="w-full text-[13px] text-ink-500">Los abiertos primero. Los anulados no se listan.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] table-fixed text-sm">
            <colgroup>
              <col />
              <col className="w-[7rem]" />
              <col className="w-[5.5rem]" />
              <col className="w-[6rem]" />
              <col className="w-[8rem]" />
              <col className="w-[5.5rem]" />
              <col className="w-[6rem]" />
              <col className="w-[11rem]" />
              <col className="w-[2.5rem]" />
            </colgroup>
            <thead className="bg-white text-left text-xs font-semibold text-ink-600 shadow-[inset_0_-1px_0_var(--color-line)]">
              <tr>
                <th className="px-4 py-2.5 sm:px-5">Manifiesto</th>
                <th className="px-3 py-2.5">Estado</th>
                <th className="px-3 py-2.5">Llegó el</th>
                <th className="px-3 py-2.5 text-right">Recibidos</th>
                <th className="px-3 py-2.5 text-right">Con observación</th>
                <th className="px-3 py-2.5 text-right">Faltan</th>
                <th className="px-3 py-2.5 text-right">Declaró</th>
                <th className="px-3 py-2.5">Cerró</th>
                <th className="px-3 py-2.5"><span className="sr-only">Abrir</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {manifests.map((m) => {
                const gap = m.declaredCount == null ? null : m.declaredCount - m.counts.arrived;
                return (
                  <tr key={m.id} className="align-top transition-colors hover:bg-wash">
                    <td className="px-4 py-2.5 sm:px-5">
                      <Link href={returnManifestPath(m.id)} className="font-semibold text-ink-900 hover:text-brand-700">{m.label}</Link>
                      <p className="truncate text-xs text-ink-500">Grupo GF{m.riderName ? ` · ${m.riderName}` : ""}{m.createdByName ? ` · abrió ${m.createdByName}` : ""}</p>
                      {m.stale && (
                        <Badge tone="warn" title="Abierto hace más de un día: ciérralo o anúlalo.">
                          <IconAlert aria-hidden className="size-3" />
                          abierto desde {limaShortDateTime(m.createdAt)}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2.5"><Badge tone={RETURN_MANIFEST_STATE_TONE[m.state]}>{RETURN_MANIFEST_STATE_LABEL[m.state]}</Badge></td>
                    <td className="px-3 py-2.5 tabular-nums text-ink-700">{boxDayShort(m.arrivedOn)}</td>
                    <td className="px-3 py-2.5 text-right"><Count value={m.counts.received} tone="ok" /></td>
                    <td className="px-3 py-2.5 text-right"><Count value={m.counts.withObservation} tone="warn" /></td>
                    <td className="px-3 py-2.5 text-right">
                      {m.state === "open" ? <span className="text-xs text-ink-500" title="Lo que faltó se anota al cerrar.">al cerrar</span> : <Count value={m.counts.missing} tone="crit" />}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">
                      {m.declaredCount == null ? "—" : m.declaredCount}
                      {gap != null && gap !== 0 && <span className="block text-xs text-warn-fg">llegaron {m.counts.arrived}</span>}
                    </td>
                    <td className="px-3 py-2.5 text-ink-700">
                      {m.closedAt ? (
                        <>
                          <p className="truncate">{m.closedByName ?? "—"}</p>
                          <p className="text-xs tabular-nums text-ink-500">{limaShortDateTime(m.closedAt)}</p>
                        </>
                      ) : <span className="text-ink-500">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Link href={returnManifestPath(m.id)} aria-label={`Abrir ${m.label}`} className="inline-flex text-ink-500 hover:text-brand-700"><IconChevronRight /></Link>
                    </td>
                  </tr>
                );
              })}
              {!manifests.length && (
                <tr>
                  <td colSpan={9} className="px-4 py-10 text-center text-sm text-ink-500">
                    <IconPlus aria-hidden className="mx-auto mb-1 size-5 text-ink-300" />
                    Todavía no hay manifiestos de devolución. Ábrelo cuando llegue un motorizado con lo de varios días.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
