import type { ReactNode } from "react";

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ── Tabla larga: encabezado fijo al scrollear ────────────────────────────────
// Dos piezas que SOLO funcionan juntas; por eso viven acá y no sueltas en cada
// módulo.
//
// 1) El contenedor NO puede ser scrollport: cualquier `overflow` distinto de
//    visible lo convierte en uno (el navegador activa el eje Y aunque solo
//    declares el X) y ahí el sticky pierde contra qué pegarse. En escritorio va
//    `visible` para que se pegue a la ventana — scrollea la página y lo de
//    arriba se oculta. En móvil se conserva el scroll horizontal (la tabla no
//    entra) a costa del sticky, que es el intercambio correcto en pantalla
//    chica.
// 2) El separador es una SOMBRA INTERNA, no un `border-b`: Tailwind fuerza
//    `border-collapse: collapse` y con bordes colapsados el borde le pertenece
//    a la tabla, no a la celda, así que no viaja con la celda fija y la línea
//    desaparece al bajar. La sombra sí se pinta con la celda.
//
// Se aplica sobre el <thead> (o su <tr>) y alcanza a todas sus celdas, porque
// cada módulo pone las clases en un nivel distinto.

/** Contenedor de una tabla que ENTRA en pantalla. Acompaña a STICKY_HEAD. */
export const TABLE_WRAP = "overflow-x-auto md:overflow-x-visible";

/**
 * Contenedor de una tabla con ancho mínimo propio (`min-w-[Npx]`).
 *
 * No se puede soltar el scroll horizontal en `md` sin más: una tabla de, por
 * ejemplo, 1640px desbordaría la página y aparecería scroll horizontal de
 * documento (con la barra lateral yéndose de lado). Acá el sticky se habilita
 * recién desde el ancho en que la tabla entra de verdad; por debajo manda el
 * scroll horizontal y no hay encabezado fijo, que es el intercambio correcto.
 *
 * Las clases son literales a propósito: Tailwind escanea el código fuente, así
 * que un breakpoint armado en runtime no se generaría.
 * Regla del pulgar: ancho de la tabla + ~340px (barra lateral + paddings).
 */
/**
 * Tabla más ancha que la mayoría de pantallas (Master de Pedidos: 1180px de
 * mínimo, más la barra lateral). Ahí no se puede tener las dos cosas: si el contenedor
 * scrollea en horizontal, el sticky muere. Este alias elige el ENCABEZADO FIJO
 * y acepta que la página scrollee en horizontal (al ir a la derecha, la barra
 * lateral se va de lado). Existe con nombre propio para que quede claro que es
 * una decisión tomada y no un olvido de ponerle breakpoint.
 */
export const TABLE_WRAP_PAGE_X = TABLE_WRAP;

export const TABLE_WRAP_FROM = {
  980: "overflow-x-auto min-[980px]:overflow-x-visible",
  1060: "overflow-x-auto min-[1060px]:overflow-x-visible",
  1110: "overflow-x-auto min-[1110px]:overflow-x-visible",
  1160: "overflow-x-auto min-[1160px]:overflow-x-visible",
  1240: "overflow-x-auto min-[1240px]:overflow-x-visible",
  1800: "overflow-x-auto min-[1800px]:overflow-x-visible",
  1980: "overflow-x-auto min-[1980px]:overflow-x-visible",
} as const;

/** Encabezado que queda fijo al tope de la ventana al scrollear la página. */
export const STICKY_HEAD =
  "[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-slate-50 [&_th]:shadow-[inset_0_-1px_0_#cbd5e1]";

/**
 * La escalera de capas de una tabla, de abajo hacia arriba y en un solo sitio.
 *
 * POR QUÉ EXISTE. Son cuatro capas repartidas entre un `class` compartido, dos
 * estilos en línea y los popovers de cada módulo. Cada vez que se tocó una
 * suelta apareció el mismo defecto: dos capas con el MISMO número, y a igual
 * z-index gana el último en el DOM — que es siempre la tabla, porque va después
 * de los filtros. Primero el encabezado fijo tapó los desplegables; al
 * arreglarlo con z-30, la esquina congelada del Master (que ya estaba en 30)
 * los siguió tapando, pero solo los de la izquierda. Escrita entera, la
 * escalera se lee de un vistazo y los empates saltan a la vista.
 *
 * El z-index de las celdas congeladas va EN LÍNEA a propósito: `STICKY_HEAD`
 * aplica su z con un selector descendiente (`.clase th`), de más especificidad
 * que una clase suelta, y ganaría.
 */
export const TABLE_LAYER = {
  /** Celda congelada del cuerpo: por debajo de cualquier encabezado. */
  frozenCell: 5,
  /** Encabezado fijo (lo pone `STICKY_HEAD` como clase). */
  head: 10,
  /** Esquina congelada: encabezado Y columna fija a la vez. */
  frozenHead: 20,
  /** Desplegables abiertos sobre la tabla. */
  popover: 30,
} as const;

/** Capa de cualquier desplegable que se abra SOBRE una tabla. Ver `TABLE_LAYER`. */
export const OVER_TABLE_Z = "z-30";

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-2xl border border-slate-200 bg-white p-5 shadow-sm", className)}>
      {children}
    </div>
  );
}

export function Section({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-wide text-slate-700 uppercase">{title}</h2>
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function DeltaBadge({ pct }: { pct: number | null }) {
  if (pct === null) {
    return <span className="text-xs font-medium text-slate-400">— sin base</span>;
  }
  const up = pct > 0;
  const flat = pct === 0;
  return (
    <span
      className={cn(
        "text-xs font-semibold",
        flat ? "text-slate-400" : up ? "text-emerald-600" : "text-red-600",
      )}
    >
      {up ? "▲" : flat ? "■" : "▼"} {up ? "+" : ""}
      {pct}%
    </span>
  );
}

export function StatCard({
  label,
  value,
  sub,
  delta,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: number | null;
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      <div className="mt-1 flex items-center gap-2">
        {delta !== undefined && <DeltaBadge pct={delta} />}
        {sub && <span className="text-xs text-slate-400">{sub}</span>}
      </div>
    </Card>
  );
}

export interface BarItem {
  label: string;
  value: number;
  valueLabel?: string;
  sublabel?: string;
}

export function BarList({ items, empty = "Sin datos" }: { items: BarItem[]; empty?: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="text-sm text-slate-400">{empty}</p>;
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-baseline justify-between text-sm">
            <span className="truncate text-slate-700">{it.label}</span>
            <span className="ml-2 shrink-0 font-medium text-slate-900">
              {it.valueLabel ?? it.value}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-brand-500"
              style={{ width: `${Math.round((it.value / max) * 100)}%` }}
            />
          </div>
          {it.sublabel && <p className="text-xs text-slate-400">{it.sublabel}</p>}
        </div>
      ))}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
}

export function SimpleTable<T>({
  columns,
  rows,
  empty = "Sin datos",
}: {
  columns: Column<T>[];
  rows: T[];
  empty?: string;
}) {
  if (!rows.length) return <p className="text-sm text-slate-400">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-500">
            {columns.map((c) => (
              <th
                key={c.key}
                className={cn("py-2 font-medium", c.align === "right" ? "text-right" : "text-left")}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-slate-100 last:border-0">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn("py-2.5 text-slate-700", c.align === "right" ? "text-right" : "text-left")}
                >
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <p className="text-base font-medium text-slate-700">{title}</p>
      {children && <div className="text-sm text-slate-500">{children}</div>}
    </Card>
  );
}

/** Pulsing placeholder block for `loading.tsx` skeletons. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-slate-200/70", className)} />;
}
