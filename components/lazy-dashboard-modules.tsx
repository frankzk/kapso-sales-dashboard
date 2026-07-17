"use client";

import dynamic from "next/dynamic";
import type { SalesAttribution } from "@/lib/metrics";
import { cn } from "@/components/ui";

type RevenueOrdersChartProps = {
  data: Array<{ date: string; revenue: number; orders: number }>;
};

type CampaignTrendChartProps = {
  rows: Array<Record<string, string | number>>;
  series: { key: string; label: string }[];
};

type ConversionOrdersTrendProps = {
  data: Array<{ date: string; conversionRate: number; orders: number }>;
};

type SalesAttributionModuleProps = {
  attribution: SalesAttribution;
  metaSpend: number | null;
  currency: string;
  timezone: string;
};

function ChartSkeleton({ className }: { className: string }) {
  return (
    <div
      className={cn(
        "grid w-full place-items-center rounded-lg bg-slate-50 text-sm text-slate-400",
        className,
      )}
    >
      Cargando gráfico…
    </div>
  );
}

const RevenueOrdersChart = dynamic(
  () => import("@/components/charts").then((module) => module.RevenueOrdersChart),
  { ssr: false, loading: () => <ChartSkeleton className="h-64" /> },
);

const CampaignTrendChart = dynamic(
  () => import("@/components/charts").then((module) => module.CampaignTrendChart),
  { ssr: false, loading: () => <ChartSkeleton className="h-64" /> },
);

const ConversionOrdersTrend = dynamic(
  () => import("@/components/charts").then((module) => module.ConversionOrdersTrend),
  { ssr: false, loading: () => <ChartSkeleton className="h-52" /> },
);

const SalesAttributionModule = dynamic(
  () =>
    import("@/components/sales-attribution").then((module) => module.SalesAttributionModule),
  { ssr: false, loading: () => <ChartSkeleton className="h-72" /> },
);

export {
  RevenueOrdersChart,
  CampaignTrendChart,
  ConversionOrdersTrend,
  SalesAttributionModule,
};
