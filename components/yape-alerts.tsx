"use client";

// Global advisor pop-up for Yape/Shalom leads awaiting verification. Polls the
// RLS-scoped queue every 15s (visible tab only) and shows a prominent, non-
// blocking card. "Tomar y atender" claims the lead (atomic — only one advisor
// can win) and opens it; whoever loses the race gets dropped silently. Once a
// lead is claimed (fresh), it leaves everyone's queue on the next poll, so two
// people never end up working the same Yape.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { claimLead, listYapeAlerts, type YapeAlert } from "@/app/dashboard/leads/actions";

const POLL_MS = 15_000;

/** Short attention beep via WebAudio (no asset). Best-effort: stays silent if the
 *  browser blocks audio before a user gesture. */
function beep() {
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

export function YapeAlerts() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<YapeAlert[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const knownRef = useRef<Set<string>>(new Set()); // ids already alerted (to beep only on new)

  const refresh = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    let next: YapeAlert[];
    try {
      next = await listYapeAlerts();
    } catch {
      return; // transient error — keep the current queue, retry next tick
    }
    setAlerts(next);
    const hasNew = next.some((a) => !knownRef.current.has(a.id));
    knownRef.current = new Set(next.map((a) => a.id)); // forget ones that left → a re-entry re-beeps
    if (hasNew) beep();
  }, []);

  useEffect(() => {
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
  }, [refresh]);

  const visible = alerts.filter((a) => !dismissed.has(a.id));
  if (!visible.length) return null;
  const top = visible[0]!;
  const extra = visible.length - 1;
  const detail = top.cartSummary || top.handoffContext || null;

  async function take(a: YapeAlert) {
    setBusyId(a.id);
    const res = await claimLead(a.id);
    setBusyId(null);
    setDismissed((s) => new Set(s).add(a.id));
    if (res.error) {
      void refresh(); // someone else got it first — refresh the queue
      return;
    }
    setAlerts((list) => list.filter((x) => x.id !== a.id));
    router.push(`/dashboard/leads?store=${a.storeId}&view=yape&open=${a.id}`);
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center p-4"
      role="alertdialog"
      aria-live="assertive"
      aria-label="Yape/Shalom por verificar"
    >
      <div className="pointer-events-auto w-full max-w-md overflow-hidden rounded-2xl border-2 border-red-300 bg-white shadow-2xl ring-4 ring-red-500/10">
        <div className="flex items-center gap-2 bg-red-600 px-4 py-2 text-white">
          <span className="animate-pulse-dot text-lg leading-none motion-reduce:animate-none" aria-hidden="true">
            🔥
          </span>
          <span className="text-sm font-semibold">Yape/Shalom por verificar</span>
          {extra > 0 && (
            <span className="ml-auto rounded-full bg-white/25 px-2 py-0.5 text-xs font-semibold tabular-nums">
              +{extra} en cola
            </span>
          )}
        </div>
        <div className="px-4 py-3">
          <p className="text-base font-semibold text-slate-900">{top.name || top.phone}</p>
          <p className="text-sm tabular-nums text-slate-500">+{top.phone}</p>
          {detail && <p className="mt-1.5 line-clamp-2 text-sm text-slate-600">{detail}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => take(top)}
              disabled={busyId === top.id}
              className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60"
            >
              {busyId === top.id ? "Tomando…" : "Tomar y atender"}
            </button>
            <button
              type="button"
              onClick={() => setDismissed((s) => new Set(s).add(top.id))}
              className="rounded-lg border border-slate-300 px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              Ahora no
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
