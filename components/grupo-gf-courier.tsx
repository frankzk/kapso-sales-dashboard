"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, cn, STICKY_HEAD, TABLE_WRAP_FROM } from "@/components/ui";
import { resolveDistrictTariff } from "@/lib/grupo-gf-courier";
import {
  activateGroupGfCourier,
  saveDistrictTariff,
  type CourierActionResult,
  type CourierConfigSnapshot,
  type CourierAgreementRow,
  type PeruDistrictRow,
} from "@/app/dashboard/courier/actions";

function today(): string {
  const value = new Date();
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function money(value: number): string {
  return `S/ ${value.toFixed(2)}`;
}

export function GrupoGfCourierBoard({
  orgId,
  snapshot,
}: {
  orgId: string;
  snapshot: CourierConfigSnapshot;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<CourierActionResult>) {
    startTransition(async () => {
      const result = await action();
      setError(result.error ?? null);
      setNotice(result.notice ?? null);
      if (!result.error) router.refresh();
    });
  }

  if (!snapshot.provider) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Operación logística
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">Grupo GF Courier</h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Activa el operador sin cambiar rutas ni inventario actuales. Se crearán los contratos
            de las tiendas activas, Yape 3.5 % y una bolsa de inventario todavía opcional.
          </p>
        </header>
        {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
        <Card className="flex flex-col gap-5 p-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">Fundación lista para activar</p>
            <ul className="mt-2 space-y-1 text-sm text-slate-600">
              <li>Lima Metropolitana y Callao</li>
              <li>Corte del mismo día: 11:30</li>
              <li>Advertencia S/ 4,000; límite S/ 5,000</li>
            </ul>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => activateGroupGfCourier(orgId))}
            className="h-10 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white transition hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50"
          >
            {pending ? "Activando…" : "Activar Grupo GF Courier"}
          </button>
        </Card>
      </div>
    );
  }

  return (
    <TariffMatrix
      orgId={orgId}
      snapshot={snapshot}
      pending={pending}
      error={error}
      notice={notice}
      onSave={(input) => run(() => saveDistrictTariff(input))}
    />
  );
}

function TariffMatrix({
  orgId,
  snapshot,
  pending,
  error,
  notice,
  onSave,
}: {
  orgId: string;
  snapshot: CourierConfigSnapshot;
  pending: boolean;
  error: string | null;
  notice: string | null;
  onSave: (input: Parameters<typeof saveDistrictTariff>[0]) => void;
}) {
  const provider = snapshot.provider!;
  const [scope, setScope] = useState("general");
  const [query, setQuery] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const agreementId = scope === "general" ? null : scope;
  const districts = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("es");
    if (!needle) return snapshot.districts;
    return snapshot.districts.filter((district) =>
      `${district.district} ${district.province}`.toLocaleLowerCase("es").includes(needle),
    );
  }, [query, snapshot.districts]);
  const configured = snapshot.districts.filter(
    (district) =>
      resolveDistrictTariff(snapshot.tariffs, {
        providerId: provider.id,
        agreementId,
        districtKey: district.district_key,
        day: effectiveFrom,
      }).kind === "found",
  ).length;

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
            Operación logística
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-950">Grupo GF Courier</h1>
          <p className="mt-1 text-sm text-slate-600">
            Tarifas incluidas IGV. Cada cambio abre una vigencia y conserva la anterior.
          </p>
        </div>
        <div className="grid grid-cols-3 divide-x divide-slate-200 rounded-xl border border-slate-200 bg-white px-1 py-3 text-sm shadow-sm">
          <Summary label="Corte" value={provider.same_day_cutoff.slice(0, 5)} />
          <Summary label="Yape" value={`${snapshot.yapePercentage} %`} />
          <Summary label="Efectivo máximo" value={money(provider.cash_limit_amount)} />
        </div>
      </header>

      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}

      <section aria-label="Filtros de tarifas" className="flex flex-col gap-3 border-y border-slate-200 py-4 md:flex-row md:items-end">
        <label className="text-xs font-medium text-slate-600">
          Tarifario
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            className="mt-1 block h-10 min-w-56 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            <option value="general">General de Grupo GF</option>
            {snapshot.agreements.map((agreement) => (
              <option key={agreement.id} value={agreement.id}>{agreement.client_label}</option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-1 text-xs font-medium text-slate-600">
          Buscar distrito
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Ej. Miraflores o Callao"
            className="mt-1 block h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Ver y registrar desde
          <input
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            className="mt-1 block h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
        </label>
        <p className="pb-2 text-xs tabular-nums text-slate-500">{configured}/{snapshot.districts.length} configurados</p>
      </section>

      <div className={cn(TABLE_WRAP_FROM[980], "rounded-xl border border-slate-200 bg-white shadow-sm")}>
        <table className="w-full min-w-[880px] text-sm">
          <thead className={STICKY_HEAD}>
            <tr className="text-left text-xs text-slate-500">
              <th className="px-4 py-3 font-medium">Distrito</th>
              <th className="px-3 py-3 font-medium">Zona</th>
              <th className="px-3 py-3 text-right font-medium">Entrega</th>
              <th className="px-3 py-3 text-right font-medium">Rechazo</th>
              <th className="px-3 py-3 font-medium">Origen</th>
              <th className="px-4 py-3 text-right font-medium">Acción</th>
            </tr>
          </thead>
          <tbody>
            {districts.map((district) => (
              <TariffRow
                key={`${scope}:${district.district_key}:${effectiveFrom}`}
                orgId={orgId}
                providerId={provider.id}
                agreementId={agreementId}
                agreement={snapshot.agreements.find((item) => item.id === agreementId) ?? null}
                district={district}
                tariffs={snapshot.tariffs}
                effectiveFrom={effectiveFrom}
                pending={pending}
                onSave={onSave}
              />
            ))}
            {!districts.length && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-slate-500">Ningún distrito coincide con la búsqueda.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="mt-0.5 whitespace-nowrap font-semibold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

function TariffRow({
  orgId,
  providerId,
  agreementId,
  agreement,
  district,
  tariffs,
  effectiveFrom,
  pending,
  onSave,
}: {
  orgId: string;
  providerId: string;
  agreementId: string | null;
  agreement: CourierAgreementRow | null;
  district: PeruDistrictRow;
  tariffs: CourierConfigSnapshot["tariffs"];
  effectiveFrom: string;
  pending: boolean;
  onSave: (input: Parameters<typeof saveDistrictTariff>[0]) => void;
}) {
  const resolution = resolveDistrictTariff(tariffs, {
    providerId,
    agreementId,
    districtKey: district.district_key,
    day: effectiveFrom,
  });
  const tariff = resolution.kind === "found" ? resolution.tariff : null;
  const [zone, setZone] = useState(tariff?.zone ?? "");
  const [delivery, setDelivery] = useState(tariff ? String(tariff.delivery_amount) : "");
  const [rejection, setRejection] = useState(tariff ? String(tariff.rejection_amount) : "");
  const inherited = agreementId != null && resolution.kind === "found" && resolution.source === "general";

  return (
    <tr className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
      <td className="px-4 py-3">
        <p className="font-medium text-slate-900">{district.district}</p>
        <p className="text-xs text-slate-500">{district.province}</p>
      </td>
      <td className="px-3 py-3">
        <input
          value={zone}
          onChange={(event) => setZone(event.target.value)}
          aria-label={`Zona de ${district.district}`}
          placeholder="Sin zona"
          className="h-9 w-40 rounded-lg border border-slate-200 bg-white px-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
      </td>
      <td className="px-3 py-3 text-right">
        <MoneyInput label={`Tarifa de entrega en ${district.district}`} value={delivery} onChange={setDelivery} />
      </td>
      <td className="px-3 py-3 text-right">
        <MoneyInput label={`Tarifa de rechazo en ${district.district}`} value={rejection} onChange={setRejection} />
      </td>
      <td className="px-3 py-3">
        {resolution.kind === "missing" ? (
          <span className="rounded-md bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">Sin tarifa</span>
        ) : inherited ? (
          <span className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">Heredada de general</span>
        ) : (
          <span className="text-xs text-slate-500">{agreement?.client_label ?? "General"}</span>
        )}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          disabled={pending || delivery.trim() === "" || rejection.trim() === ""}
          onClick={() => onSave({
            orgId,
            providerId,
            agreementId,
            districtKey: district.district_key,
            zone,
            deliveryAmount: delivery,
            rejectionAmount: rejection,
            effectiveFrom,
          })}
          className="h-9 rounded-lg px-3 text-sm font-semibold text-brand-700 transition hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:text-slate-300"
        >
          {tariff && !inherited ? "Cambiar" : inherited ? "Crear excepción" : "Guardar"}
        </button>
      </td>
    </tr>
  );
}

function MoneyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative inline-block">
      <span className="sr-only">{label}</span>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">S/</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode="decimal"
        aria-label={label}
        placeholder="0.00"
        className="h-9 w-24 rounded-lg border border-slate-200 bg-white pl-8 pr-2 text-right text-sm tabular-nums outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
      />
    </label>
  );
}
