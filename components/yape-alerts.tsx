"use client";

// Global advisor pop-up for Yape/Shalom leads awaiting verification. Polls the
// RLS-scoped queue every 15s (visible tab only) and shows a prominent, non-
// blocking card. "Tomar y atender" claims the lead (atomic — only one advisor
// can win) and opens it; whoever loses the race gets dropped silently. Once a
// lead is claimed (fresh), it leaves everyone's queue on the next poll, so two
// people never end up working the same Yape.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  assignYape,
  claimLead,
  passYape,
  type YapeAlert,
} from "@/app/dashboard/leads/actions";
import { listStoreVendedoras, listYapeAlerts } from "@/lib/leads-read-client";
import { Badge, FIELD, FLOATING_ALERT, FLOATING_ALERT_ICON, OpsButton } from "@/components/ops-ui";
import { IconMoney } from "@/components/icons";
import { cn } from "@/components/ui";

const POLL_MS = 15_000;

/** Short attention beep via WebAudio (no asset). Best-effort: stays silent if the
 *  browser blocks audio before a user gesture. */
export function beep() {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.value = 0.06;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => void ctx.close();
  } catch {
    /* audio not available */
  }
}

export function YapeAlerts({ enabled = true }: { enabled?: boolean }) {
  const router = useRouter();
  const [alerts, setAlerts] = useState<YapeAlert[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const knownRef = useRef<Set<string>>(new Set()); // ids already alerted (to beep only on new)
  const pollingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    if (typeof document !== "undefined" && document.hidden) return;
    if (pollingRef.current) return;
    pollingRef.current = true;
    let next: YapeAlert[];
    try {
      next = await listYapeAlerts();
    } catch {
      return; // transient error — keep the current queue, retry next tick
    } finally {
      pollingRef.current = false;
    }
    setAlerts(next);
    const hasNew = next.some((a) => !knownRef.current.has(a.id));
    knownRef.current = new Set(next.map((a) => a.id)); // forget ones that left → a re-entry re-beeps
    if (hasNew) beep();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setAlerts([]);
      knownRef.current = new Set();
      return;
    }
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    const onVis = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, refresh]);

  if (!enabled || !alerts.length) return null;
  const top = alerts[0]!;
  const extra = alerts.length - 1;
  const detail = top.cartSummary || top.handoffContext || null;

  function drop(id: string) {
    setAlerts((list) => list.filter((x) => x.id !== id));
    knownRef.current.delete(id); // if the loop re-offers it later, it re-beeps
  }

  async function take(a: YapeAlert) {
    setBusyId(a.id);
    const res = await claimLead(a.id);
    setBusyId(null);
    drop(a.id);
    if (res.error) {
      void refresh(); // someone else got it first
      return;
    }
    // `oid` sella ESTA pulsación. La cola solo obedece una orden que no haya
    // cumplido ya, y sin sello no podría distinguir "Tomar otra vez el mismo
    // Yape" de "el parámetro volvió a aparecer solo".
    router.push(
      `/dashboard/leads?store=${a.storeId}&view=yape&open=${a.id}&oid=${Date.now()}`,
    );
  }

  // "Ahora no" → escalate to the next advisor right away (I'm added to `passed`).
  async function pass(a: YapeAlert) {
    drop(a.id);
    await passYape(a.id);
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center p-4"
      role="alertdialog"
      aria-live="assertive"
      aria-label="Yape/Shalom por verificar"
    >
      <div className={FLOATING_ALERT}>
        <div className="flex items-start gap-3">
          {/* La urgencia la dice el disco crítico con su punto que pulsa, no un emoji. */}
          <span className={FLOATING_ALERT_ICON} aria-hidden="true">
            <IconMoney className="size-[18px]" />
            <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-urgent ring-2 ring-white animate-pulse-dot motion-reduce:animate-none" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-[15px] font-semibold leading-5 text-ink-900">Yape/Shalom por verificar</h2>
              {extra > 0 && (
                <Badge tone="urgent" className="ml-auto tabular-nums">
                  +{extra} en cola
                </Badge>
              )}
            </div>
            <p className="mt-2 text-base font-semibold leading-6 text-ink-900">{top.name || top.phone}</p>
            <p className="text-[13px] leading-5 tabular-nums text-ink-500">+{top.phone}</p>
            {detail && <p className="mt-1.5 line-clamp-2 text-sm leading-5 text-ink-700">{detail}</p>}
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <OpsButton variant="primary" size="lg" className="flex-1" onClick={() => take(top)} disabled={busyId === top.id}>
            {busyId === top.id ? "Tomando…" : "Tomar y atender"}
          </OpsButton>
          <OpsButton size="lg" onClick={() => pass(top)}>
            Ahora no
          </OpsButton>
        </div>
      </div>
    </div>
  );
}

/** Admin-only control inside the drawer: assign a Yape to a specific vendedora.
 *  Self-gating — `listStoreVendedoras` returns [] for non-admins, so it renders
 *  nothing for them. */
export function YapeAssign({
  leadId,
  storeId,
  onAssigned,
}: {
  leadId: string;
  storeId: string;
  onAssigned?: () => void;
}) {
  const [vendedoras, setVendedoras] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    listStoreVendedoras(storeId).then((v) => {
      if (alive) setVendedoras(v);
    }).catch(() => { if (alive) setMsg({ text: "No se pudieron cargar las asesoras.", ok: false }); });
    return () => {
      alive = false;
    };
  }, [storeId]);

  if (!vendedoras || !vendedoras.length) return null;

  async function assign(id: string) {
    if (!id) return;
    setBusy(true);
    const res = await assignYape(leadId, id);
    setBusy(false);
    setMsg(res.error ? { text: res.error, ok: false } : { text: "Asignado ✓", ok: true });
    onAssigned?.();
  }

  // Zona sobre el lavado, sin anillo: va dentro del cajón y no es otra tarjeta.
  return (
    <div className="rounded-lg bg-wash px-3 py-2.5">
      <label htmlFor={`yape-assign-${leadId}`} className="mb-1.5 block text-[13px] font-medium leading-5 text-ink-700">
        Asignar Yape a
      </label>
      <select
        id={`yape-assign-${leadId}`}
        defaultValue=""
        disabled={busy}
        onChange={(e) => assign(e.currentTarget.value)}
        className={FIELD}
      >
        <option value="">Elegir vendedora…</option>
        {vendedoras.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={cn("mt-1.5 text-[13px] leading-5", msg.ok ? "text-ok-fg" : "text-crit-fg")}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
