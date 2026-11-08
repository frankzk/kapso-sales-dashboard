"use client";

// «Distrito por revisar» en el Master (MOM §19.0.3, owner 08-11-2026): los
// pedidos abiertos cuyo distrito es la capital de provincia y cuya dirección
// nombra otro distrito de esa provincia. La lista sale del servidor en una
// pasada (`getDistrictReview`); aquí solo se enseña y se corrige con el
// guardado de siempre (`updateOrderGeo`, vía `applyDistrictFix`). Sin sondeo:
// tras corregir se recarga la página y el pedido sale solo de la lista.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Banner, CHECKBOX, OpsButton, SECTION_CARD, SectionHead } from "@/components/ops-ui";
import { cn } from "@/components/ui";
import { applyDistrictFix } from "@/components/district-mismatch-warning";
import { DISTRICT_REVIEW_LABEL, districtFixLabel } from "@/lib/district-mismatch";
import type { DistrictReviewItem } from "@/lib/district-mismatch-access";
import { courierDisplayName } from "@/lib/dispatched-with";

/** Los que se pueden corregir en lote: los que tienen UNA sola sugerencia. */
export function bulkFixable(items: readonly DistrictReviewItem[]): DistrictReviewItem[] {
  return items.filter((item) => item.suggested.length === 1);
}

export function DistrictReviewPanel({
  items,
  canEdit,
  onOpen,
  onClose,
}: {
  items: DistrictReviewItem[];
  canEdit: boolean;
  /** Abre la ficha del pedido en Información → Ubicación. */
  onOpen: (orderId: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "crit"; text: string } | null>(null);
  const fixable = useMemo(() => bulkFixable(items), [items]);
  // Lo elegido que sigue en la lista (tras recargar, lo corregido se va).
  const chosen = fixable.filter((item) => selected.has(item.orderId));
  const allChosen = fixable.length > 0 && chosen.length === fixable.length;

  const toggle = (orderId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });

  const fixOne = (item: DistrictReviewItem, district: string) => {
    setMessage(null);
    setBusyId(item.orderId);
    start(async () => {
      const res = await applyDistrictFix(item.orderId, district);
      setBusyId(null);
      if (res.error) {
        setMessage({ tone: "crit", text: `${item.orderName ?? "El pedido"}: ${res.error}` });
        return;
      }
      setMessage({ tone: "ok", text: `${item.orderName ?? "Pedido"}: distrito corregido a ${district}.` });
      router.refresh();
    });
  };

  const fixChosen = () => {
    const batch = chosen;
    if (!batch.length) return;
    setMessage(null);
    start(async () => {
      const failed: string[] = [];
      // Uno tras otro: cada corrección recalcula su pedido y deja su rastro.
      for (const item of batch) {
        const district = item.suggested[0];
        if (!district) continue;
        setBusyId(item.orderId);
        const res = await applyDistrictFix(item.orderId, district).catch((e: unknown) => ({
          error: e instanceof Error ? e.message : "Error",
        }));
        if (res.error) failed.push(`${item.orderName ?? item.orderId}: ${res.error}`);
      }
      setBusyId(null);
      setSelected(new Set());
      const done = batch.length - failed.length;
      setMessage(
        failed.length
          ? { tone: done ? "warn" : "crit", text: `Corregidos ${done} de ${batch.length}. ${failed.join(" · ")}` }
          : { tone: "ok", text: `Corregidos ${done} ${done === 1 ? "pedido" : "pedidos"}.` },
      );
      router.refresh();
    });
  };

  return (
    <section aria-labelledby="distrito-por-revisar" className={SECTION_CARD}>
      <SectionHead
        id="distrito-por-revisar"
        title={DISTRICT_REVIEW_LABEL}
        badge={<Badge tone={items.length ? "warn" : "neutral"}>{items.length.toLocaleString("es-PE")}</Badge>}
        help="Pedidos abiertos de provincia con la capital como distrito y otro distrito de la misma provincia en la dirección. El courier va a la capital y anula la guía: corrige antes de crearla. Si la guía ya salió, corregir aquí no se la cambia al courier."
        aside={
          <OpsButton size="sm" variant="ghost" onClick={onClose} className="pointer-coarse:h-11">
            Cerrar
          </OpsButton>
        }
      />
      <div className="space-y-3 pt-4">
        {message && (
          <Banner tone={message.tone} role={message.tone === "crit" ? "alert" : "status"}>
            {message.text}
          </Banner>
        )}
        {items.length === 0 ? (
          <p className="text-sm text-ink-500">Ningún pedido abierto con el distrito por revisar.</p>
        ) : (
          <>
            {canEdit && fixable.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <label className="flex items-center gap-2 text-[13px] font-medium text-ink-700">
                  <input
                    type="checkbox"
                    checked={allChosen}
                    onChange={() =>
                      setSelected(allChosen ? new Set() : new Set(fixable.map((item) => item.orderId)))
                    }
                    className={CHECKBOX}
                  />
                  Elegir los {fixable.length.toLocaleString("es-PE")} con una sola sugerencia
                </label>
                <OpsButton
                  size="sm"
                  variant="primary"
                  onClick={fixChosen}
                  disabled={pending || chosen.length === 0}
                  className="ml-auto pointer-coarse:h-11"
                >
                  {pending && busyId && chosen.length ? "Corrigiendo…" : `Corregir seleccionados (${chosen.length})`}
                </OpsButton>
              </div>
            )}
            <ul className="divide-y divide-line overflow-hidden rounded-md ring-1 ring-line">
              {items.map((item) => {
                const single = item.suggested.length === 1;
                const busy = busyId === item.orderId;
                return (
                  <li key={item.orderId} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5 text-sm leading-5">
                    {canEdit && (
                      <input
                        type="checkbox"
                        aria-label={`Elegir ${item.orderName ?? "pedido"}`}
                        checked={single && selected.has(item.orderId)}
                        disabled={!single || pending}
                        title={single ? undefined : "Con varias sugerencias se corrige de a uno."}
                        onChange={() => toggle(item.orderId)}
                        className={cn(CHECKBOX, "mt-0.5")}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2">
                        <button
                          type="button"
                          onClick={() => onOpen(item.orderId)}
                          className="font-mono font-medium text-brand-700 hover:underline"
                        >
                          {item.orderName ?? "—"}
                        </button>
                        <span className="text-ink-900">
                          {item.current} <span aria-hidden>→</span>
                          <span className="sr-only">debería ser</span>{" "}
                          <b className="font-semibold">{item.suggested.join(" o ")}</b>
                        </span>
                        {item.guideCode && (
                          <Badge tone="neutral" title="La guía ya salió con el distrito anterior: corregir aquí no se la cambia al courier.">
                            Ya con {item.courier ? courierDisplayName(item.courier) : "courier"} · {item.guideCode}
                          </Badge>
                        )}
                      </p>
                      <p className="truncate text-[13px] text-ink-500" title={item.address ?? undefined}>
                        {item.address ?? "—"}
                      </p>
                    </div>
                    {canEdit && (
                      <div className="flex flex-wrap gap-2">
                        {item.suggested.map((district) => (
                          <OpsButton
                            key={district}
                            size="sm"
                            onClick={() => fixOne(item, district)}
                            disabled={pending}
                            className="pointer-coarse:h-11"
                          >
                            {busy ? "Corrigiendo…" : single ? "Corregir" : districtFixLabel(district)}
                          </OpsButton>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
