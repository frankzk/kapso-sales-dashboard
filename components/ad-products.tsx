"use client";

// Declarar qué producto vende cada anuncio de Meta.
//
// La pantalla existe porque el dato no está en ninguna parte: quien llega por
// un anuncio nunca pasa por la ficha del producto, así que su lead trae `ad_id`
// y nada más. Alguien tiene que decirlo una vez por anuncio.
//
// LO QUE LA PANTALLA NO HACE: aplicar la sugerencia sola. El histórico propone
// —«de este anuncio suelen comprar Beewax, 98 % sobre 44 pedidos»— y la persona
// declara o no. El panel trae el producto sugerido ya escrito, pero declararlo
// sigue siendo un toque de alguien. Un anuncio sin declarar deja a sus leads en
// «Sin producto», que es la verdad, en vez de en un producto probable, que es
// una mentira que nadie puede ver.
//
// Y LA DECLARACIÓN TIENE FECHA. Un creativo que funciona se reutiliza para otro
// producto —el del café que hoy vende el gel de limpieza de lengua—, así que un
// anuncio puede tener varios periodos. Cada lead toma el que valía el día que
// entró; declarar hoy no reescribe lo que ya se trabajó.

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, ChoiceChip, FIELD, FIELD_BOX, OpsButton, SidePanel, StatusCard, type BadgeTone } from "@/components/ops-ui";
import { ChoicePill } from "@/components/facet-pill";
import { CopyButton } from "@/components/copy-button";
import { IconSearch } from "@/components/icons";
import {
  FUERZA_LABEL,
  fuerzaEvidencia,
  type AdDeclaration,
  type AdProductRow,
} from "@/lib/ad-products";
import { productLabel } from "@/lib/leads";
import {
  declareAdProduct,
  refreshAdSuggestions,
  removeAdDeclaration,
} from "@/app/dashboard/leads/anuncios/actions";

export interface AdRow extends AdProductRow {
  leads: number;
  declaraciones: AdDeclaration[];
}

/** «desde siempre» o la fecha, en corto. */
function desdeLabel(validFrom: string): string {
  const v = validFrom.trim().toLowerCase();
  if (v === "-infinity") return "desde siempre";
  const t = Date.parse(validFrom);
  return Number.isNaN(t)
    ? validFrom
    : `desde ${new Date(t).toLocaleDateString("es-PE", { day: "2-digit", month: "short", year: "numeric" })}`;
}

const FUERZA_TONE: Record<string, BadgeTone> = {
  fuerte: "ok",
  dudosa: "warn",
  ninguna: "neutral",
};

/** Para comparar el título sugerido con el nombre de un handle: sin tildes ni mayúsculas. */
const plano = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

type Vista = "pendientes" | "declarados" | "todos";

export function AdProductsBoard({
  ads,
  handles,
  stores,
  canEdit,
}: {
  ads: AdRow[];
  handles: string[];
  stores: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const storeName = useMemo(() => {
    const byId = new Map(stores.map((s) => [s.id, s.name]));
    return (id: string) => byId.get(id) ?? "—";
  }, [stores]);

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, after?: () => void) =>
    start(async () => {
      const res = await fn();
      setMsg({ ok: res.ok, text: res.error ?? res.message ?? "" });
      if (res.ok) {
        after?.();
        router.refresh();
      }
    });

  // Cuántos leads dependen de una firma que todavía no existe. Es el número que
  // dice si vale la pena sentarse a esto.
  const pendientes = useMemo(
    () => ads.filter((a) => !a.declaraciones.length).reduce((n, a) => n + a.leads, 0),
    [ads],
  );
  const declarados = useMemo(() => ads.filter((a) => a.declaraciones.length).length, [ads]);
  const sinDeclarar = ads.length - declarados;

  const [vista, setVista] = useState<Vista>(sinDeclarar > 0 ? "pendientes" : "todos");
  const [tienda, setTienda] = useState("");
  const [query, setQuery] = useState("");
  const q = plano(query);
  const shown = ads.filter(
    (a) =>
      (vista === "todos" || (vista === "pendientes" ? !a.declaraciones.length : a.declaraciones.length > 0)) &&
      (!tienda || a.store_id === tienda) &&
      (!q || plano(a.ad_headline ?? "").includes(q) || a.ad_id.includes(query.trim())),
  );

  const [abierto, setAbierto] = useState<string | null>(null);
  const open = abierto ? ads.find((a) => `${a.store_id}::${a.ad_id}` === abierto) ?? null : null;

  if (!ads.length) {
    return (
      <div className="flex flex-col gap-4">
        <Header pendientes={0} declarados={0} total={0} canEdit={false} busy={false} onRefresh={() => undefined} />
        <p className="rounded-lg bg-white px-4 py-6 text-sm text-ink-500 shadow-control ring-1 ring-line">
          No hay anuncios con leads en la cola.
        </p>
      </div>
    );
  }

  const titulo = vista === "pendientes" ? "Sin declarar" : vista === "declarados" ? "Declarados" : "Todos";

  return (
    <div className="flex flex-col gap-4">
      <Header
        pendientes={pendientes}
        declarados={declarados}
        total={ads.length}
        canEdit={canEdit}
        busy={busy}
        onRefresh={() => run(() => refreshAdSuggestions())}
        storePill={
          stores.length > 1 ? (
            <ChoicePill
              label="Tienda"
              allLabel="Todas las tiendas"
              allValue=""
              options={stores.map((s) => ({ value: s.id, label: s.name }))}
              value={tienda}
              onChange={setTienda}
            />
          ) : null
        }
      />

      <p className="max-w-[68ch] text-[13px] leading-5 text-ink-600">
        Quien llega por un anuncio nunca pasa por la ficha del producto, así que su lead no trae ninguno. Declararlo acá
        lo pone en el mismo producto que los que sí llegaron por la ficha. Si un creativo se reutilizó para otra cosa, pon
        la fecha desde la que vale: cada lead toma lo que el anuncio vendía el día que entró, y el pasado no se reescribe.
      </p>

      {msg?.text && (
        <Banner tone={msg.ok ? "ok" : "crit"} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </Banner>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatusCard
          label="Sin declarar"
          value={sinDeclarar}
          active={vista === "pendientes"}
          onClick={() => setVista("pendientes")}
          marker={sinDeclarar > 0 ? <span aria-hidden className="size-2 shrink-0 rounded-full bg-warn-fg" /> : undefined}
        />
        <StatusCard label="Declarados" value={declarados} active={vista === "declarados"} onClick={() => setVista("declarados")} />
        <StatusCard label="Todos" value={ads.length} active={vista === "todos"} onClick={() => setVista("todos")} />
      </div>

      <section aria-labelledby="anuncios-titulo" className="overflow-hidden rounded-lg bg-white shadow-control ring-1 ring-line">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 shadow-[inset_0_-1px_0_var(--color-line)]">
          <h2 id="anuncios-titulo" className="text-sm font-semibold text-ink-900">
            {titulo} <span className="font-normal tabular-nums text-ink-500">{shown.length}</span>
          </h2>
          <label className="relative block w-full sm:w-64">
            <span className="sr-only">Buscar anuncio</span>
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por titular o ID"
              className={cn(FIELD_BOX, "h-8 w-full pl-8 pr-3 pointer-coarse:h-11")}
            />
          </label>
        </div>
        <div className="hidden grid-cols-[minmax(0,1.3fr)_72px_minmax(0,1fr)_minmax(0,1.2fr)_128px] gap-4 px-4 py-2 text-xs font-semibold text-ink-600 shadow-[inset_0_-1px_0_var(--color-line)] lg:grid">
          <span>Anuncio</span>
          <span className="text-right">Leads</span>
          <span>Suele vender (histórico)</span>
          <span>Qué vende, y desde cuándo</span>
          <span />
        </div>
        {shown.map((ad) => {
          const key = `${ad.store_id}::${ad.ad_id}`;
          const fuerza = fuerzaEvidencia(ad);
          return (
            <div
              key={key}
              className="flex flex-col gap-2 border-t border-line px-4 py-3 first:border-t-0 lg:grid lg:grid-cols-[minmax(0,1.3fr)_72px_minmax(0,1fr)_minmax(0,1.2fr)_128px] lg:items-center lg:gap-4"
            >
              <div className="min-w-0">
                <p className={cn("truncate text-sm font-semibold", ad.ad_headline ? "text-ink-900" : "text-ink-500")}>
                  {ad.ad_headline || "Sin titular"}
                </p>
                {/* El id se muestra porque el titular NO identifica: hay cuatro
                    anuncios de Beewax con tres titulares distintos, y dos de
                    ellos son nombres de archivo de video. */}
                <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-ink-500">
                  {storeName(ad.store_id)}
                  {" · "}
                  <span className="truncate font-mono">{ad.ad_id}</span>
                  <CopyButton value={ad.ad_id} label="el ID del anuncio" />
                </p>
              </div>
              <p className="text-sm font-semibold tabular-nums text-ink-900 lg:text-right">
                {ad.leads.toLocaleString("es-PE")}
                <span className="ml-1 font-normal text-ink-500 lg:hidden">leads</span>
              </p>
              <div className="min-w-0">
                {ad.suggested_label ? (
                  <>
                    <p className="truncate text-[13px] text-ink-900">{ad.suggested_label}</p>
                    <p className="mt-1">
                      <Badge tone={FUERZA_TONE[fuerza]}>
                        {FUERZA_LABEL[fuerza]} · {ad.evidence_pct ?? 0}&nbsp;% de {ad.evidence_sample ?? 0}
                      </Badge>
                    </p>
                  </>
                ) : (
                  <p className="text-[13px] text-ink-500">Sin evidencia todavía</p>
                )}
              </div>
              <div className="min-w-0">
                {/* Los periodos declarados, del más nuevo al más viejo. Un anuncio
                    reutilizado tiene varios y cada lead toma el que valía el día
                    que entró. */}
                {ad.declaraciones.length > 0 ? (
                  <ul className="flex flex-col gap-1">
                    {ad.declaraciones.map((d) => (
                      <li key={d.id ?? d.valid_from} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[13px]">
                        <span className="font-medium text-ink-900">{productLabel(d.product_handle)}</span>
                        <span className="text-xs text-ink-500">
                          {desdeLabel(d.valid_from)}
                          {d.note && ` · ${d.note}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Badge tone="warn">Sin declarar</Badge>
                )}
              </div>
              <div className="flex lg:justify-end">
                {canEdit && (
                  <OpsButton size="sm" variant={ad.declaraciones.length ? "ghost" : "secondary"} onClick={() => setAbierto(key)} aria-haspopup="dialog">
                    {ad.declaraciones.length ? "Añadir periodo" : "Declarar"}
                  </OpsButton>
                )}
              </div>
            </div>
          );
        })}
        {!shown.length && <p className="border-t border-line px-4 py-6 text-sm text-ink-500">Nada con estos filtros.</p>}
      </section>

      {open && canEdit && (
        <DeclararPanel
          key={abierto}
          ad={open}
          handles={handles}
          storeName={storeName(open.store_id)}
          busy={busy}
          onClose={() => setAbierto(null)}
          onDeclare={(handle, validFrom) =>
            run(
              () =>
                declareAdProduct({
                  storeId: open.store_id,
                  adId: open.ad_id,
                  handle,
                  validFrom,
                  adHeadline: open.ad_headline ?? null,
                }),
              () => setAbierto(null),
            )
          }
          onRemove={(declarationId) => run(() => removeAdDeclaration({ storeId: open.store_id, declarationId }))}
        />
      )}
    </div>
  );
}

function Header({
  pendientes,
  declarados,
  total,
  canEdit,
  busy,
  onRefresh,
  storePill,
}: {
  pendientes: number;
  declarados: number;
  total: number;
  canEdit: boolean;
  busy: boolean;
  onRefresh: () => void;
  storePill?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[28px] font-bold leading-9 tracking-[-0.01em] text-ink-900">Anuncios</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          Qué vende cada anuncio
          {total > 0 && (
            <>
              {" · "}
              {pendientes.toLocaleString("es-PE")} leads esperan una firma{" · "}
              {declarados} de {total} anuncios declarados
            </>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {storePill}
        {canEdit && (
          <OpsButton disabled={busy} onClick={onRefresh}>
            Recalcular sugerencias
          </OpsButton>
        )}
      </div>
    </header>
  );
}

function DeclararPanel({
  ad,
  handles,
  storeName,
  busy,
  onClose,
  onDeclare,
  onRemove,
}: {
  ad: AdRow;
  handles: string[];
  storeName: string;
  busy: boolean;
  onClose: () => void;
  onDeclare: (handle: string, validFrom: string | null) => void;
  onRemove: (declarationId: string) => void;
}) {
  const fuerza = fuerzaEvidencia(ad);
  // El producto sugerido viene como título de pedido; si coincide con el nombre
  // de un handle conocido, se escribe ya. Declararlo sigue siendo un toque.
  const sugerido = useMemo(() => {
    if (!ad.suggested_label) return "";
    const target = plano(ad.suggested_label);
    return handles.find((h) => plano(productLabel(h)) === target) ?? "";
  }, [ad.suggested_label, handles]);
  // El campo muestra el NOMBRE del producto; lo que se guarda es su handle.
  const porNombre = useMemo(() => new Map(handles.map((h) => [plano(productLabel(h)), h])), [handles]);
  const [texto, setTexto] = useState(ad.declaraciones.length || !sugerido ? "" : productLabel(sugerido));
  const escrito = texto.trim();
  const resuelto = porNombre.get(plano(escrito)) ?? (handles.includes(escrito) ? escrito : null);
  const handle = resuelto ?? escrito;
  const [conFecha, setConFecha] = useState(ad.declaraciones.length > 0);
  const [desde, setDesde] = useState("");
  const hoy = new Date().toISOString().slice(0, 10);

  // Escape cierra, como los demás paneles.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const listo = !!handle && (!conFecha || !!desde);

  return (
    <SidePanel
      label={`Declarar el producto de ${ad.ad_headline || "este anuncio"}`}
      title={ad.ad_headline || "Sin titular"}
      meta={
        <>
          {storeName} · <span className="font-mono">{ad.ad_id}</span> · {ad.leads.toLocaleString("es-PE")} leads
        </>
      }
      width="max-w-[520px]"
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        {ad.suggested_label ? (
          <Banner tone={fuerza === "fuerte" ? "ok" : "warn"} title={`De este anuncio suelen comprar ${ad.suggested_label}`}>
            {FUERZA_LABEL[fuerza]}: {ad.evidence_pct ?? 0}&nbsp;% de {ad.evidence_sample ?? 0} pedidos. Es una sugerencia: no
            se aplica sola.
          </Banner>
        ) : (
          <Banner tone="info">Sin evidencia todavía: nadie compró desde este anuncio en los pedidos que se miraron.</Banner>
        )}

        <label className="block">
          <span className="text-[13px] font-medium text-ink-700">Producto</span>
          <span className="relative mt-1 block">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-500" />
            <input
              list="handles-conocidos"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              placeholder="Buscar el producto"
              className={cn(FIELD_BOX, "h-9 w-full pl-8 pr-3 pointer-coarse:h-11")}
            />
          </span>
          <span className="mt-1 block text-xs text-ink-500">
            {resuelto
              ? `Se guarda como «${resuelto}», el mismo producto que la ficha.`
              : escrito
                ? "No está entre los productos de los enlaces: se guarda tal cual lo escribiste."
                : "De los productos que ya aparecen en los enlaces: así cae en el mismo grupo que la ficha."}
          </span>
        </label>
        {/* Los handles que ya existen en links. Elegir de esta lista es lo que
            garantiza que el anuncio caiga en el MISMO balde que la ficha. */}
        <datalist id="handles-conocidos">
          {handles.map((h) => (
            <option key={h} value={productLabel(h)} />
          ))}
        </datalist>

        <div>
          <span className="text-[13px] font-medium text-ink-700">Desde cuándo</span>
          {/* La fecha solo hace falta cuando el anuncio CAMBIÓ de producto. En
              blanco vale desde siempre, que es el caso normal. */}
          <div role="group" aria-label="Desde cuándo" className="mt-1 flex flex-wrap items-center gap-1.5">
            <ChoiceChip label="Desde siempre" active={!conFecha} onClick={() => setConFecha(false)} />
            <ChoiceChip label="Desde una fecha" active={conFecha} onClick={() => setConFecha(true)} />
            {conFecha && (
              <input
                type="date"
                value={desde}
                max={hoy}
                aria-label="Desde qué día vende este producto"
                onChange={(e) => setDesde(e.target.value)}
                className={cn(FIELD, "w-44")}
              />
            )}
          </div>
          <span className="mt-1 block text-xs text-ink-500">Solo si el creativo cambió de producto. El pasado no se reescribe.</span>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
          <OpsButton variant="ghost" onClick={onClose}>
            Cancelar
          </OpsButton>
          <OpsButton variant="primary" disabled={busy || !listo} onClick={() => onDeclare(handle, conFecha ? desde : null)}>
            {ad.declaraciones.length ? "Añadir periodo" : "Declarar"}
          </OpsButton>
        </div>

        <section>
          <h3 className="text-sm font-semibold text-ink-900">Periodos</h3>
          {ad.declaraciones.length ? (
            <ul className="mt-2 flex flex-col">
              {ad.declaraciones.map((d) => (
                <li key={d.id ?? d.valid_from} className="flex items-center justify-between gap-3 border-t border-line py-2 first:border-t-0">
                  <span className="min-w-0 text-[13px]">
                    <span className="font-medium text-ink-900">{productLabel(d.product_handle)}</span>{" "}
                    <span className="text-ink-500">
                      {desdeLabel(d.valid_from)}
                      {d.note && ` · ${d.note}`}
                    </span>
                  </span>
                  {d.id && (
                    <OpsButton size="sm" variant="ghost" disabled={busy} onClick={() => onRemove(d.id!)}>
                      Quitar
                    </OpsButton>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[13px] text-ink-500">
              Todavía no tiene ninguno: sus {ad.leads.toLocaleString("es-PE")} leads están en «Sin producto».
            </p>
          )}
        </section>
      </div>
    </SidePanel>
  );
}
