"use client";

import { useId, useRef, type ReactNode } from "react";
import { cn } from "@/components/ui";

const TABS = [
  { value: "current", label: "Interés actual" },
  { value: "entry", label: "Producto de entrada" },
] as const;

export function LeadProductTabs({ value, onChange, children }: {
  value: "current" | "entry";
  onChange: (value: "current" | "entry") => void;
  children: ReactNode;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  return (
    <div className="min-w-0">
      <div ref={list} role="tablist" aria-label="Filtrar productos por"
        className="mb-3 grid min-w-0 grid-cols-2 gap-0.5 rounded-lg bg-wash p-0.5 ring-1 ring-inset ring-line">
        {TABS.map((tab, index) => (
          <button key={tab.value} type="button" role="tab" id={`${id}-${tab.value}`}
            aria-selected={value === tab.value} aria-controls={`${id}-panel`} tabIndex={value === tab.value ? 0 : -1}
            onClick={() => { if (value !== tab.value) onChange(tab.value); }}
            onKeyDown={(event) => {
              const next = event.key === "Home" ? 0 : event.key === "End" ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowRight" ? 1 - index : null;
              if (next === null) return;
              event.preventDefault();
              if (value !== TABS[next]!.value) onChange(TABS[next]!.value);
              list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}
            className={cn("min-h-9 min-w-0 rounded-md px-2 py-2 text-[13px] font-medium leading-4 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 pointer-coarse:min-h-11",
              value === tab.value ? "bg-white text-brand-700 shadow-control" : "text-ink-600 hover:text-ink-900")}>
            {tab.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${value}`} className="min-w-0">
        {children}
      </div>
    </div>
  );
}
