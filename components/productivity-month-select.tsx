"use client";

import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";

/**
 * «Otro mes…»: los meses que no caben como chip. Navega al elegir, como los
 * chips; se pinta encendido cuando el mes que se mira está aquí y no en un chip.
 */
export function ProductivityMonthSelect({
  options,
  value,
  active,
}: {
  options: { month: string; label: string; href: string }[];
  value: string | null;
  active: boolean;
}) {
  const router = useRouter();
  return (
    <label className="relative">
      <span className="sr-only">Elegir otro mes</span>
      <select
        value={active && value ? value : ""}
        onChange={(event) => {
          const option = options.find((o) => o.month === event.target.value);
          if (option) router.push(option.href);
        }}
        className={cn(
          "cursor-pointer rounded-lg border py-1 pr-6 pl-2 text-xs",
          active
            ? "border-brand-500 bg-brand-50 font-medium text-brand-700"
            : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
        )}
      >
        <option value="" disabled>
          Otro mes…
        </option>
        {options.map((o) => (
          <option key={o.month} value={o.month}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
