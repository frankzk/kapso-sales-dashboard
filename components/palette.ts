// Colores de los gráficos en hexadecimal (Recharts y SVG no leen clases de
// Tailwind). `CHART` es la paleta del aspecto anterior, que todavía usa
// components/leads-insights.tsx; lo nuevo usa `SERIES`, `VIZ` y compañía.

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

/**
 * Paleta de DATOS del mundo de operación (Consolidado, 13-10-2026). Orden fijo:
 * la serie N lleva siempre el color N, y lo que no entra va en `SERIES_OTHER`.
 * Validada con el validador de dataviz en modo claro: diferencia mínima entre
 * vecinos con daltonismo ΔE 9.1 y con visión normal ΔE 19.6; aguamarina, ámbar
 * y rosa quedan bajo 3:1 sobre blanco, así que van siempre con etiqueta o con
 * la tabla al lado. Sin verde ni rojo: son colores de estado (`ok`, `crit`).
 */
export const SERIES = ["#2f74ff", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#6250d6"] as const;
/** «Otros», «Sin atribuir»: la tinta clara, fuera de la paleta. */
export const SERIES_OTHER = "#a3acba";

/** Los tokens de tinta y líneas del mundo de operación, en hexadecimal para Recharts y SVG. */
export const VIZ = {
  ink900: "#1a1b25",
  ink600: "#545969",
  ink500: "#687385",
  ink300: "#a3acba",
  line: "#ebeef1",
  lineStrong: "#d5dbe1",
  brand: "#2f74ff",
  brandSoft: "#8fbcff",
  ok: "#006908",
  warn: "#a82c00",
  crit: "#b3063d",
} as const;

/**
 * Los tres canales de cierre van en una escala de tinta, de menos a más mano
 * humana (bot → bot asistido → asesora): es un orden, no tres identidades, y así
 * no se confunden con los colores de las fuentes en el mismo panel.
 */
export const CHANNEL_SHADE = { bot: "#a3acba", bot_asistido: "#687385", asesora: "#1a1b25" } as const;

/**
 * Un color por fuente de venta, en el orden canónico de
 * `ATTRIBUTION_SOURCE_ORDER` (lib/metrics), que es el orden en que se apilan:
 * así los vecinos de la barra son los vecinos validados de `SERIES`.
 */
export const SOURCE_SERIES: Record<string, string> = {
  meta_ad: SERIES[0],
  fb_web: SERIES[1],
  cod_cart: SERIES[2],
  abandoned_browse: SERIES[3],
  winback: SERIES[4],
  organic: SERIES[5],
  sin_atribucion: SERIES_OTHER,
};

/** El color de una serie de anuncios: por posición, y «Otros» en tinta clara. */
export function trendColor(key: string, index: number): string {
  return key === "otros" ? SERIES_OTHER : (SERIES[index % SERIES.length] ?? SERIES_OTHER);
}
