"use client";

import { useEffect, useRef } from "react";
import { cn } from "./ui";
import {
  PRODUCTIVITY_SECTIONS,
  productivityHref,
  type ProductivitySection,
} from "@/lib/operations-productivity";
import type { DateRange } from "@/lib/access";

export function ProductivityTabs({
  section,
  range,
  store,
  month = null,
  source = null,
}: {
  section: ProductivitySection;
  range: DateRange;
  store: string | null;
  month?: string | null;
  source?: string | null;
}) {
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navigation.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollLeft = Math.max(
      0,
      active.offsetLeft -
        nav.offsetLeft -
        (nav.clientWidth - active.offsetWidth) / 2,
    );
  }, [section]);
  return (
    <nav
      ref={navigation}
      aria-label="Secciones de productividad"
      className="-mb-px flex shrink-0 gap-5 overflow-x-auto border-b border-line"
    >
      {PRODUCTIVITY_SECTIONS.map(([key, label]) => (
        <a
          key={key}
          href={productivityHref(key, range, store, month, source)}
          aria-current={section === key ? "page" : undefined}
          className={cn(
            "inline-flex min-h-11 shrink-0 items-center border-b-2 px-0.5 text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-inset",
            section === key
              ? "border-brand-600 text-brand-700"
              : "border-transparent text-ink-500 hover:border-line-strong hover:text-ink-900",
          )}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}
