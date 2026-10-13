"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Badge, Banner, OpsButton, type BadgeTone } from "@/components/ops-ui";
import { cambiarAutomaticoPc, simularAutomaticoPc, type SimulacionPc } from "@/app/dashboard/pedidos/swayp-desde-confirmar/actions";
import { PC_AUTO_ARM_LABEL, PC_AUTO_REASONS, type PcAutoArm } from "@/lib/swayp-pc-auto-labels";
import type { PcAutoBrazo, PcAutoResumen } from "@/lib/swayp-pc-auto-access";

const nf = new Intl.NumberFormat("es-PE");

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)} %` : "—";
}

/**
 * El panel del Swayp automático desde Por confirmar (MOM §11.13): estado,
 * interruptor, simulación de la pasada de hoy y la comparación de los dos
 * brazos del piloto. Lo de activar y simular es de «Administrar tiendas».
 */
export function SwaypPcAutoPanel({
  orgId,
  canManage,
  resumen,
}: {
  orgId: string;
  canManage: boolean;
  resumen: PcAutoResumen;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sim, setSim] = useState<SimulacionPc | null>(null);
  const s = resumen.settings;

  if (!s) {
    return (
      <Banner tone="warn" role="status">
        <p>El automático todavía no está instalado en la base (migración 0253).</p>
      </Banner>
    );
  }

  const estado: { tone: BadgeTone; label: string } = s.enabled
    ? { tone: "ok", label: "Activo" }
    : s.paused_reason
      ? { tone: "crit", label: "Pausado por el freno" }
      : { tone: "neutral", label: "Apagado" };

  function cambiar(enabled: boolean) {
    setError(null);
    start(async () => {
      const r = await cambiarAutomaticoPc(orgId, enabled);
      if (r.error) setError(r.error);
    });
  }
  function simular() {
    setError(null);
    start(async () => {
      const r = await simularAutomaticoPc(orgId);
      if (r.error) setError(r.error);
      else setSim(r);
    });
  }

  return (
    <section aria-label="Automático" className="space-y-4 rounded-lg bg-white p-4 shadow-control ring-1 ring-line sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-ink-900">Automático · piloto A/B</h2>
            <Badge tone={estado.tone}>{estado.label}</Badge>
          </div>
          <p className="max-w-[80ch] text-pretty text-[13px] leading-5 text-ink-600">
            Cada día a las 6:30 p. m. mira los pedidos de provincia COD en Por confirmar de hasta {s.max_age_hours} h,
            con {s.min_attempts === 1 ? "al menos 1 llamada" : `al menos ${s.min_attempts} llamadas`} y no más de{" "}
            {s.max_unanswered} sin respuesta, dirección con número o manzana y lote, sin agencia, hasta S/ {nf.format(Number(s.max_amount))},
            ubicación corroborada y stock completo en la bodega. La mitad sale por Swayp y la otra mitad sigue las
            llamadas, para comparar. Hasta {s.daily_cap} por día y {s.per_warehouse_cap} por bodega. Se apaga solo si de
            los últimos {s.brake_window} resueltos se entrega menos del {Math.round(Number(s.brake_min_rate) * 100)} %.
          </p>
          {!s.enabled && s.paused_reason && <p className="text-[13px] leading-5 text-crit-fg">{s.paused_reason}</p>}
          <p className="text-[13px] leading-5 text-ink-500">
            Hoy: {nf.format(resumen.creadosHoy)} de {s.daily_cap} enviados
            {resumen.ultimaPasada &&
              ` · última pasada ${new Date(resumen.ultimaPasada.at).toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <OpsButton variant="ghost" disabled={pending} onClick={simular} className="pointer-coarse:h-11">
              Simular la pasada de hoy
            </OpsButton>
            {s.enabled ? (
              <OpsButton variant="danger" disabled={pending} onClick={() => cambiar(false)} className="pointer-coarse:h-11">
                Pausar
              </OpsButton>
            ) : (
              <OpsButton disabled={pending} onClick={() => cambiar(true)} className="pointer-coarse:h-11">
                Activar
              </OpsButton>
            )}
          </div>
        )}
      </div>

      {error && (
        <Banner tone="crit" role="alert">
          <p>{error}</p>
        </Banner>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {(["swayp", "control"] as PcAutoArm[]).map((arm) => (
          <BrazoCard key={arm} label={PC_AUTO_ARM_LABEL[arm]} b={resumen.brazos[arm]} />
        ))}
      </div>

      {sim?.braked && (
        <Banner tone="crit" role="status">
          <p>
            El freno está activo: de los últimos {sim.braked.casos} casos resueltos del brazo Swayp se entregó el{" "}
            {Math.round((sim.braked.tasa ?? 0) * 100)} %. Con esa tasa no saldría ningún pedido.
          </p>
        </Banner>
      )}

      {sim && !sim.braked && (
        <div className="space-y-2 border-t border-line pt-3">
          <p className="text-sm text-ink-700">
            Simulación de hoy: {nf.format(sim.checked ?? 0)} mirados ·{" "}
            <b className="font-semibold text-ink-900">{nf.format(sim.eligibleSwayp ?? 0)} saldrían por Swayp</b> ·{" "}
            {nf.format(sim.eligibleControl ?? 0)} irían al control. No se envió nada.
          </p>
          {!!sim.items?.length && (
            <ul className="grid gap-1 text-[13px] leading-5">
              {sim.items.map((i) => (
                <li key={i.orderId} className="flex flex-wrap items-center gap-x-2">
                  <Link href={`/dashboard/pedidos?abrir=${encodeURIComponent(i.orderId)}`} className="font-medium text-brand-700 hover:underline">
                    {i.orderName ?? "Pedido"}
                  </Link>
                  {i.arm && <Badge tone={i.arm === "swayp" ? "ok" : "neutral"}>{PC_AUTO_ARM_LABEL[i.arm as PcAutoArm]}</Badge>}
                  <span className="text-ink-600">{PC_AUTO_REASONS[i.reason] ?? i.reason}</span>
                  {i.bodega && <span className="text-ink-500">· {i.bodega}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function BrazoCard({ label, b }: { label: string; b: PcAutoBrazo }) {
  const resueltos = b.entregados + b.noEntregados;
  return (
    <div className="rounded-md bg-wash p-3">
      <p className="text-[13px] font-medium text-ink-700">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-ink-900">{pct(b.entregados, resueltos)}</p>
      <p className="text-[13px] leading-5 tabular-nums text-ink-600">
        entregados de los resueltos · {nf.format(b.total)} pedidos: {nf.format(b.entregados)} entregados,{" "}
        {nf.format(b.noEntregados)} no, {nf.format(b.enCurso)} en curso
      </p>
    </div>
  );
}
