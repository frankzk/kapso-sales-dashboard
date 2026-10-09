import { cn } from "@/components/ui";
import { ORDER_COVERAGE_LABEL, type OrderCoverage } from "@/lib/order-coverage";

/**
 * La cobertura del pedido como chapa de 4 px (Master, ficha, Ajustes).
 *
 * La cobertura es una CLASIFICACIÓN, no un estado: por eso no usa los pares
 * `ok`/`warn`/`crit` —un «Agencia» en ámbar se leería como un problema— ni los
 * matices de las macroetapas, que van en la misma fila. Lleva un tinte suave
 * (fondo 50, anillo 200, texto 800) de un matiz propio: Lima violeta,
 * Provincia COD verde azulado, Agencia fucsia. Queda más callado que la chapa
 * de etapa (100/800), que sigue siendo lo más fuerte de la fila. «Por revisar»
 * es la única con el par `warn`, porque pide que alguien actúe.
 */
export const COVERAGE_TONE: Record<OrderCoverage, string> = {
  lima: "bg-violet-50 text-violet-800 ring-1 ring-inset ring-violet-200",
  provincia_cod: "bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-200",
  agencia: "bg-fuchsia-50 text-fuchsia-800 ring-1 ring-inset ring-fuchsia-200",
  por_revisar: "bg-warn-bg text-warn-fg",
};

export function CoverageBadge({ coverage }: { coverage: string | null | undefined }) {
  // Sin cobertura calculada, el pedido está por revisar; un valor que no
  // conocemos se enseña tal cual y en gris.
  const value = coverage ?? "por_revisar";
  const known = Object.hasOwn(COVERAGE_TONE, value);
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded px-1.5 text-xs font-medium leading-none",
        known ? COVERAGE_TONE[value as OrderCoverage] : "bg-line text-ink-600",
      )}
    >
      {known ? ORDER_COVERAGE_LABEL[value as OrderCoverage] : value}
    </span>
  );
}
