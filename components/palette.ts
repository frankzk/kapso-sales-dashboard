// Shared color palette for charts and accent UI. Recharts needs hex values
// (not Tailwind classes), so the canonical colors live here and are reused by
// every chart + the premium dashboard accents. Mirrors the Tailwind palette.

export const CHART = {
  brand: "#2f74ff",
  green: "#10b981",
  blue: "#3b82f6",
  teal: "#14b8a6",
  purple: "#8b5cf6",
  orange: "#f97316",
  yellow: "#eab308",
  amber: "#f59e0b",
  red: "#ef4444",
  slate: "#94a3b8",
  grid: "#eef2f7",
} as const;

export type AccentColor = "brand" | "green" | "blue" | "teal" | "purple" | "orange" | "yellow" | "amber" | "red";

/** Tailwind class triplet for a soft accent chip (bg + text) per accent color. */
export const ACCENT_CHIP: Record<AccentColor, string> = {
  brand: "bg-brand-50 text-brand-700",
  green: "bg-emerald-50 text-emerald-700",
  blue: "bg-blue-50 text-blue-700",
  teal: "bg-teal-50 text-teal-700",
  purple: "bg-violet-50 text-violet-700",
  orange: "bg-orange-50 text-orange-700",
  yellow: "bg-yellow-50 text-yellow-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-700",
};

/** Solid bar fill (Tailwind bg-*) per accent color, for div-based bars. */
export const ACCENT_BAR: Record<AccentColor, string> = {
  brand: "bg-brand-500",
  green: "bg-emerald-500",
  blue: "bg-blue-500",
  teal: "bg-teal-500",
  purple: "bg-violet-500",
  orange: "bg-orange-500",
  yellow: "bg-yellow-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};
