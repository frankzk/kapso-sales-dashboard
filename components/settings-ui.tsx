"use client";

// Piezas de la página de Ajustes (02-10-2026): la configuración del panel de
// Stripe dentro del mundo de operación (DESIGN.md). Un índice lateral fijo que
// marca la sección visible, secciones con su chapa de estado y tarjetas
// blancas de filas separadas por hairlines, cada una con su propio «Guardar».

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import { FIELD } from "@/components/ops-ui";

/** Tarjeta blanca de 8 px con anillo `line` y sombra de control. */
export const CARD = "rounded-lg bg-white shadow-control ring-1 ring-line";

/** Relleno de una fila dentro de la tarjeta. */
export const ROW = "px-4 py-4 sm:px-5";

/** Texto de ayuda: 13 px en tinta tenue, con `strong` y `code` legibles. */
export const HELP = "text-[13px] leading-5 text-ink-500 [&_strong]:font-semibold [&_strong]:text-ink-700 [&_em]:text-ink-700";

/** Campo de número: el mismo campo, con cifras tabulares. */
export const NUMBER_FIELD = cn(FIELD, "tabular-nums");

/**
 * Campo de número corto (horas, días, topes): sin el ancho completo, para que
 * quien lo usa le dé el de su cifra (`w-20`, `w-28`). Con `w-full` dentro, el
 * ancho propio perdía contra él según el orden de la hoja de estilos.
 */
export const NUMBER_NARROW = cn(FIELD.replace("w-full ", ""), "tabular-nums");

/** Área de texto: el campo, sin la altura fija de 36 px. */
export const TEXTAREA = cn(FIELD, "h-auto py-2 leading-5");

export interface IndexGroup {
  title: string;
  items: Array<{ id: string; label: string }>;
}

/**
 * El índice de la página: en escritorio ancho, una columna pegajosa con los
 * grupos y sus secciones; debajo, un selector pegajoso «Ir a». Los dos marcan
 * la sección que se está leyendo, y llevan a ella sin recargar.
 */
export function SettingsIndex({ groups, children }: { groups: IndexGroup[]; children: ReactNode }) {
  const ids = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.id)), [groups]);
  const [active, setActive] = useState(ids[0] ?? "");
  const rail = useRef<HTMLDivElement>(null);

  // La sección activa es la primera que cruza una franja del 15 al 35 % de la
  // ventana: lo que el ojo está leyendo, no lo que asoma por abajo.
  useEffect(() => {
    const visible = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        const first = ids.find((id) => visible.get(id));
        if (first) setActive(first);
      },
      { rootMargin: "-15% 0px -65% 0px" },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [ids]);

  // El índice tiene su propio scroll en ventanas bajas: el ítem activo no se
  // puede quedar fuera de la vista. A mano, porque `scrollIntoView` movería
  // también la página.
  useEffect(() => {
    const nav = rail.current;
    const item = nav?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!nav || !item) return;
    // La columna es pegajosa, así que es el `offsetParent` de sus ítems.
    const top = item.offsetTop;
    if (top < nav.scrollTop + 8) nav.scrollTop = top - 8;
    else if (top + item.offsetHeight > nav.scrollTop + nav.clientHeight - 8) {
      nav.scrollTop = top + item.offsetHeight - nav.clientHeight + 8;
    }
  }, [active]);

  const go = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
    setActive(id);
  }, []);

  return (
    <div className="xl:grid xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-10">
      <nav aria-label="Secciones de ajustes" className="hidden xl:block">
        <div ref={rail} className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto overscroll-contain pb-6 pr-1">
          {groups.map((g) => (
            <div key={g.title} className="mt-5 first:mt-0">
              <p className="px-2.5 text-xs font-semibold leading-4 text-ink-500">{g.title}</p>
              <ul className="mt-1.5 space-y-px">
                {g.items.map((i) => {
                  const on = i.id === active;
                  return (
                    <li key={i.id}>
                      <a
                        href={`#${i.id}`}
                        data-index={i.id}
                        aria-current={on ? "location" : undefined}
                        onClick={(e) => {
                          e.preventDefault();
                          go(i.id);
                        }}
                        className={cn(
                          "flex h-7 items-center rounded-md px-2.5 text-[13px] transition-colors duration-150",
                          on ? "bg-brand-50 font-semibold text-brand-700" : "font-medium text-ink-600 hover:bg-white hover:text-ink-900",
                        )}
                      >
                        <span className="truncate">{i.label}</span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </nav>

      <div className="min-w-0">
        <div className="sticky top-0 z-20 -mx-4 bg-slate-50 px-4 py-2 shadow-[inset_0_-1px_0_var(--color-line)] sm:-mx-5 sm:px-5 xl:hidden">
          <label className="flex items-center gap-3">
            <span className="shrink-0 text-[13px] font-medium text-ink-600">Ir a</span>
            <select value={active} onChange={(e) => go(e.target.value)} className={FIELD}>
              {groups.map((g) => (
                <optgroup key={g.title} label={g.title}>
                  {g.items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-6 space-y-14 xl:mt-0">{children}</div>
      </div>
    </div>
  );
}

/** Un grupo del índice (Conexiones, Mensajes automáticos…): título de 20 px. */
export function SettingsGroup({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <div className="border-b border-line pb-3">
        <h2 id={id} className="text-xl font-semibold leading-7 text-ink-900">
          {title}
        </h2>
        {description && <p className="mt-1 max-w-prose text-sm leading-5 text-ink-500">{description}</p>}
      </div>
      <div className="mt-8 space-y-12">{children}</div>
    </section>
  );
}

/**
 * Una sección: título de 16 px con su chapa de estado, la explicación debajo
 * y, a la derecha, las acciones que no guardan nada (probar, sincronizar).
 */
export function SettingsSection({
  id,
  title,
  badge,
  description,
  actions,
  children,
}: {
  id: string;
  title: string;
  badge?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 xl:scroll-mt-6">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-80">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h3 id={`${id}-title`} className="text-base font-semibold leading-6 text-ink-900">
              {title}
            </h3>
            {badge}
          </div>
          {description && (
            <div className="mt-1 max-w-[68ch] space-y-2 text-sm leading-5 text-ink-500 [&_strong]:font-semibold [&_strong]:text-ink-700 [&_em]:text-ink-700">
              {description}
            </div>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

/** Cabecera de una tarjeta cuando la sección tiene más de una. */
export function CardHeader({ title, description, aside }: { title: string; description?: ReactNode; aside?: ReactNode }) {
  return (
    <div className={cn(ROW, "flex flex-wrap items-start justify-between gap-3")}>
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-sm font-semibold leading-5 text-ink-900">{title}</p>
        {description && <div className={cn(HELP, "mt-0.5")}>{description}</div>}
      </div>
      {aside}
    </div>
  );
}

/** Campo con su etiqueta de 13 px, una marca opcional y la ayuda debajo. */
export function Field({
  label,
  htmlFor,
  mark,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  mark?: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="flex min-h-5 flex-wrap items-center gap-x-2 gap-y-1">
        <label htmlFor={htmlFor} className="text-[13px] font-medium leading-5 text-ink-700">
          {label}
        </label>
        {mark}
      </div>
      <div className="mt-1.5">{children}</div>
      {hint && <div className={cn(HELP, "mt-1.5 space-y-1.5")}>{hint}</div>}
    </div>
  );
}

/** Rejilla de campos: una columna en el teléfono, dos o tres desde `sm`. */
export function FieldGrid({ cols = 2, className, children }: { cols?: 2 | 3; className?: string; children: ReactNode }) {
  return (
    <div className={cn(ROW, "grid gap-x-4 gap-y-5", cols === 3 ? "sm:grid-cols-2 lg:grid-cols-3" : "sm:grid-cols-2", className)}>
      {children}
    </div>
  );
}

/**
 * Interruptor de sí/no que se envía con el formulario.
 *
 * Una casilla sin marcar no viaja en el formulario, y el servidor lee «no vino»
 * como «no lo cambies»: así no se podría APAGAR nada. Por eso detrás va un
 * oculto con "false"; marcada, la casilla va antes y `formData.get` devuelve su
 * "true". Sin controlar a propósito: el reinicio del formulario tras guardar lo
 * devuelve a lo persistido, como al resto de campos.
 */
export function Switch({
  id,
  name,
  defaultChecked,
  on = "Encendido",
  off = "Apagado",
}: {
  id: string;
  name: string;
  defaultChecked: boolean;
  on?: string;
  off?: string;
}) {
  return (
    <>
      <span className="relative inline-flex shrink-0 items-center gap-2.5 pointer-coarse:min-h-11">
        <input
          id={id}
          type="checkbox"
          role="switch"
          name={name}
          value="true"
          defaultChecked={defaultChecked}
          className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer appearance-none opacity-0"
        />
        <span aria-hidden className="hidden text-[13px] font-medium text-ink-500 sm:inline sm:peer-checked:hidden">
          {off}
        </span>
        <span aria-hidden className="hidden text-[13px] font-medium text-ink-900 sm:peer-checked:inline">
          {on}
        </span>
        <span
          aria-hidden
          className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors duration-150 motion-reduce:transition-none peer-hover:bg-ink-300 peer-checked:bg-brand-600 peer-checked:peer-hover:bg-brand-700 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand-500 peer-checked:[&>span]:translate-x-4"
        >
          <span className="absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-control transition-transform duration-150 motion-reduce:transition-none" />
        </span>
      </span>
      <input type="hidden" name={name} value="false" />
    </>
  );
}

/** Fila con un interruptor: qué hace a la izquierda, el interruptor a la derecha. */
export function ToggleRow({
  name,
  label,
  description,
  defaultChecked,
  on,
  off,
  children,
}: {
  name: string;
  label: ReactNode;
  description?: ReactNode;
  defaultChecked: boolean;
  on?: string;
  off?: string;
  /** Avisos que acompañan al interruptor, debajo de su explicación. */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={ROW}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <label htmlFor={id} className="cursor-pointer text-sm font-semibold leading-5 text-ink-900">
            {label}
          </label>
          {description && <div className={cn(HELP, "mt-0.5 max-w-[68ch] space-y-1.5")}>{description}</div>}
        </div>
        <Switch id={id} name={name} defaultChecked={defaultChecked} on={on} off={off} />
      </div>
      {children && <div className="mt-3 space-y-2">{children}</div>}
    </div>
  );
}

/** Un horario «de X a Y h» en una sola fila, con cifras tabulares. */
export function HourRange({
  label,
  startName,
  endName,
  start,
  end,
  hint,
}: {
  label: string;
  startName: string;
  endName: string;
  start: number;
  end: number;
  hint?: ReactNode;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-[13px] font-medium leading-5 text-ink-700">{label}</legend>
      <div className="mt-1.5 flex items-center gap-2">
        <input aria-label={`${label}: desde`} name={startName} type="number" min={0} max={23} defaultValue={start} className={cn(NUMBER_NARROW, "w-20")} />
        <span className="text-sm text-ink-500">a</span>
        <input aria-label={`${label}: hasta`} name={endName} type="number" min={1} max={24} defaultValue={end} className={cn(NUMBER_NARROW, "w-20")} />
        <span className="text-sm text-ink-500">h</span>
      </div>
      {hint && <div className={cn(HELP, "mt-1.5")}>{hint}</div>}
    </fieldset>
  );
}

/** Una URL o un valor para copiar: monoespaciada, sobre el lavado. */
export function CodeLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div translate="no" className={cn("min-w-0 flex-1 break-all rounded-md bg-wash px-3 py-2 font-mono text-xs leading-5 text-ink-700 ring-1 ring-inset ring-line", className)}>
      {children}
    </div>
  );
}

/** Lista de filas dentro de una tarjeta (plantillas, cuentas, excepciones). */
export function RowList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-line">{children}</ul>;
}

/** Lo que dice una lista vacía: qué significa, no «no hay nada». */
export function EmptyRow({ children }: { children: ReactNode }) {
  return <p className={cn(ROW, "text-sm text-ink-500")}>{children}</p>;
}
