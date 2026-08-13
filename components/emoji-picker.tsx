"use client";

import { useEffect, useRef, useState } from "react";
import {
  ALL_EMOJIS,
  DEFAULT_RECENTS,
  EMOJI_GROUPS,
  RECENTS_KEY,
  pushRecent,
  searchEmojis,
} from "@/lib/emoji";

/**
 * El selector de emojis del compositor de Leads.
 *
 * Abre HACIA ARRIBA porque el compositor vive pegado al borde inferior del
 * cajón: hacia abajo se saldría de la pantalla en cualquier portátil.
 *
 * No cierra al elegir. Mandar "listo ✅📦" es lo normal, y cerrar tras cada
 * emoji obligaría a abrirlo tres veces para una sola frase. Se cierra con Esc,
 * con el botón, o pinchando fuera.
 *
 * La lista y la lógica de inserción están en lib/emoji.ts, con pruebas: lo que
 * puede fallar en silencio es dónde cae el emoji dentro del texto, no cómo se
 * pinta la rejilla.
 */
export function EmojiPicker({
  onPick,
  disabled,
}: {
  /** Recibe el carácter. Quien llama decide dónde insertarlo. */
  onPick: (emoji: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState(EMOJI_GROUPS[0]!.id);
  const [recents, setRecents] = useState<string[]>(DEFAULT_RECENTS);
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Los recientes viven en el navegador: son una preferencia de quien escribe,
  // no un dato del negocio, y no valen un viaje al servidor ni una columna.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(RECENTS_KEY);
      const saved = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(saved) && saved.length) {
        setRecents(saved.filter((v): v is string => typeof v === "string"));
      }
    } catch {
      /* localStorage lleno, bloqueado o con basura: se usan los de por defecto */
    }
  }, []);

  // Esc y clic fuera. Solo se escucha con el panel abierto para no dejar dos
  // oyentes globales por cada lead que se abra en la sesión.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  function choose(emoji: string) {
    onPick(emoji);
    const next = pushRecent(recents, emoji);
    setRecents(next);
    try {
      window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
      /* que no se guarde el historial no puede impedir mandar el mensaje */
    }
  }

  const results = searchEmojis(query);
  const buscando = query.trim().length > 0;
  const activo = EMOJI_GROUPS.find((g) => g.id === group) ?? EMOJI_GROUPS[0]!;
  // Un reciente que ya no esté en el catálogo (lista recortada en una versión
  // posterior) se ignora en vez de pintar un hueco.
  const recientes = recents.filter((e) => ALL_EMOJIS.some((x) => x.e === e));

  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setQuery("");
        }}
        disabled={disabled}
        title="Emojis"
        aria-label="Emojis"
        aria-expanded={open}
        aria-haspopup="dialog"
        className="rounded-full p-2 text-lg leading-none text-slate-500 hover:bg-slate-100 disabled:opacity-60"
      >
        😊
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Selector de emojis"
          className="absolute bottom-full left-0 z-30 mb-2 w-[min(20rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white shadow-xl"
        >
          <div className="border-b border-slate-100 p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Buscar emoji"
              aria-label="Buscar emoji"
              className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
            />
          </div>

          {!buscando && (
            <div className="flex gap-0.5 border-b border-slate-100 px-2 py-1.5">
              {EMOJI_GROUPS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setGroup(g.id)}
                  title={g.label}
                  aria-label={g.label}
                  aria-pressed={g.id === group}
                  className={
                    "flex-1 rounded-lg py-1 text-base leading-none " +
                    (g.id === group ? "bg-emerald-50" : "hover:bg-slate-100")
                  }
                >
                  {g.icon}
                </button>
              ))}
            </div>
          )}

          <div className="max-h-56 overflow-y-auto p-2">
            {buscando ? (
              results.length ? (
                <Grid items={results.map((r) => r.e)} onPick={choose} />
              ) : (
                <p className="px-1 py-6 text-center text-xs text-slate-400">
                  Sin resultados para «{query.trim()}»
                </p>
              )
            ) : (
              <>
                {recientes.length > 0 && (
                  <>
                    <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                      Recientes
                    </p>
                    <Grid items={recientes} onPick={choose} />
                    <div className="my-2 border-t border-slate-100" />
                  </>
                )}
                <p className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">
                  {activo.label}
                </p>
                <Grid items={activo.items.map((i) => i.e)} onPick={choose} />
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Grid({ items, onPick }: { items: string[]; onPick: (e: string) => void }) {
  return (
    <div className="grid grid-cols-8 gap-0.5">
      {items.map((e, i) => (
        <button
          // El mismo emoji puede repetirse entre recientes y grupo: la clave
          // lleva el índice para no colapsar dos botones en uno.
          key={`${e}-${i}`}
          type="button"
          // `onMouseDown` con preventDefault: sin esto el clic le quita el foco
          // al textarea ANTES de insertar, y el navegador pierde la posición del
          // cursor — el emoji acabaría al final del mensaje.
          onMouseDown={(ev) => ev.preventDefault()}
          onClick={() => onPick(e)}
          title={e}
          className="rounded-lg py-1 text-xl leading-none hover:bg-slate-100"
        >
          {e}
        </button>
      ))}
    </div>
  );
}
