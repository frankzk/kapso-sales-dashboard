"use client";

// Los módulos con Recharts se cargan al abrir su panel: el tablero de
// Consolidado se dibuja sin la librería y cada gráfico la pide cuando aparece.

import dynamic from "next/dynamic";
import { cn } from "@/components/ui";

function ChartSkeleton({ className }: { className: string }) {
  return (
    <div aria-hidden className={cn("w-full animate-pulse rounded-lg bg-wash", className)} />
  );
}

const DailyBars = dynamic(() => import("@/components/charts").then((m) => m.DailyBars), {
  ssr: false,
  loading: () => <ChartSkeleton className="h-[200px]" />,
});

const DailyLine = dynamic(() => import("@/components/charts").then((m) => m.DailyLine), {
  ssr: false,
  loading: () => <ChartSkeleton className="h-[200px]" />,
});

const StackedDailyBars = dynamic(() => import("@/components/charts").then((m) => m.StackedDailyBars), {
  ssr: false,
  loading: () => <ChartSkeleton className="h-[240px]" />,
});

const TrendLines = dynamic(() => import("@/components/charts").then((m) => m.TrendLines), {
  ssr: false,
  loading: () => <ChartSkeleton className="h-[240px]" />,
});

const SalesAttributionModule = dynamic(
  () => import("@/components/sales-attribution").then((m) => m.SalesAttributionModule),
  { ssr: false, loading: () => <ChartSkeleton className="h-96" /> },
);

export { DailyBars, DailyLine, StackedDailyBars, TrendLines, SalesAttributionModule };
