"use client";

// Registrar la venta de alguien que NO está en la cola.
//
// EL CASO. El cliente llamó, o escribió por otro lado, y la venta no le cuenta
// a nadie: de 1.226 pedidos `venta_manual` en 90 días, 30 no tienen lead con
// ese teléfono y su asesor no aparece en Productividad.
//
// LO QUE ESTA PANTALLA ES: la puerta de entrada, no un formulario nuevo. Pide
// tienda y teléfono, avisa si el cliente ya tiene pedido, y abre la gaveta de
// siempre — la que ya sabe buscar productos, validar dirección y mandar la
// confirmación. Un segundo formulario garantizaría que dentro de tres meses uno
// valide el distrito y el otro no.
//
// EL TELÉFONO VA PRIMERO, y no es un detalle de orden. `leads` tiene índice
// único por (tienda, teléfono): preguntarlo al final significaría llenar diez
// campos para que la base rechace la inserción al guardar.
//
// LA GAVETA SE ABRE AQUÍ MISMO, sin navegar. La primera versión hacía
// `router.push("/dashboard/leads?open=…")`, y eso obligaba al servidor a rehacer
// la página entera —los ~2.500 leads de la cola, los siete conteos y los
// gráficos— antes de que se viera nada: cinco segundos de pantalla idéntica a la
// de antes del clic. Ahora se llama a la misma función que usa la lista, así que
// la ficha aparece en cuanto responde el detalle de ESE lead.
//
// Y MIENTRAS TANTO SE DICE. Cada espera de esta tarjeta —consultar el teléfono y
// abrir la ficha— tiene su propio estado y su propio texto. Un botón que se
// queda igual mientras trabaja se pulsa cuatro veces, que fue exactamente lo que
// pasó.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Banner, ChoiceChip, FIELD, OpsButton, SidePanel } from "@/components/ops-ui";
import { IconChevronRight, IconPhone } from "@/components/icons";
import {
  abrirClienteParaVenta,
  consultarClientePorTelefono,
  type ClienteParaVenta,
} from "@/app/dashboard/leads/venta-telefonica-actions";
import { cuandoLabel, RIESGO_TITULO, type AvisoDuplicado } from "@/lib/pedido-duplicado";
import { etiquetaCandidato, ordenarCandidatos } from "@/lib/lead-sin-numero";
import type { PhoneSaleRequest } from "@/lib/master-phone-sale";

// El tono de cada aviso: un duplicado frena, un pedido abierto pide mirar, una
// recompra solo informa.
const TONO = { duplicado: "crit", revisar: "warn", recompra: "info" } as const;

function Aviso({ aviso }: { aviso: AvisoDuplicado }) {
  if (aviso.riesgo === "ninguno") return null;
  const p = aviso.pedido;
  return (
    <Banner tone={TONO[aviso.riesgo]} title={RIESGO_TITULO[aviso.riesgo]}>
      <p className="tabular-nums">
        {p.name ?? "Pedido"} · {cuandoLabel(aviso.horas)}
        {p.total_amount != null && ` · S/\u00a0${p.total_amount.toFixed(2)}`}
        {p.general_status && ` · ${p.general_status.replace(/_/g, " ")}`}
      </p>
      {p.titulos.length > 0 && <p className="text-ink-500">{p.titulos.slice(0, 3).join(", ")}</p>}
      {aviso.riesgo === "duplicado" && (
        <p className="mt-1 font-medium text-ink-900">
          Revisa ese pedido antes de crear otro: puede ser la misma venta dos veces.
        </p>
      )}
    </Banner>
  );
}

function Spinner() {
  return (
    <svg className="size-3.5 animate-spin motion-reduce:animate-none" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function VentaTelefonica({
  stores,
  defaultStoreId,
  onAbrir,
  request,
  onOpenChange,
  openingError,
}: {
  stores: { id: string; name: string }[];
  defaultStoreId?: string | null;
  /** Abre la ficha del lead en la gaveta. Resuelve cuando ya tiene datos. */
  onAbrir: (leadId: string) => Promise<boolean>;
  /** Otra entrada al mismo panel, con el cliente identificado en el Master. */
  request?: PhoneSaleRequest | null;
  onOpenChange?: (open: boolean) => void;
  openingError?: string | null;
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [consultando, setConsultando] = useState(false);
  const [abriendo, setAbriendo] = useState(false);
  const [storeId, setStoreId] = useState(defaultStoreId ?? stores[0]?.id ?? "");
  const [phone, setPhone] = useState("");
  const [nombre, setNombre] = useState("");
  const [res, setRes] = useState<ClienteParaVenta | null>(null);

  const cerrar = () => {
    ++consultaRef.current;
    setConsultando(false);
    setAbierto(false);
    onOpenChange?.(false);
    setPhone("");
    setNombre("");
    setRes(null);
  };

  // Consultar es solo mirar: no crea nada. Así el aviso de duplicado sale ANTES
  // de que alguien empiece a llenar el pedido, que es cuando todavía es barato
  // parar.
  //
  // El token descarta la respuesta de una consulta vieja: si se corrige el
  // número mientras la anterior viaja, el aviso que llegue tarde sería de OTRO
  // cliente, y un aviso de duplicado equivocado es peor que ninguno.
  const consultaRef = useRef(0);
  useEffect(() => {
    if (!request) return;
    ++consultaRef.current;
    setConsultando(false);
    setStoreId(request.storeId);
    setPhone(request.phone);
    setNombre(request.name ?? "");
    setRes(null);
    setAbierto(true);
    onOpenChange?.(true);
  }, [request,onOpenChange]);
  const consultar = async () => {
    const token = ++consultaRef.current;
    setConsultando(true);
    try {
      const r = await consultarClientePorTelefono(storeId, phone, nombre);
      if (consultaRef.current === token) setRes(r);
    } catch {
      if (consultaRef.current === token) setRes({ok:false,error:"No se pudo consultar el cliente. Intenta nuevamente."});
    } finally {
      if (consultaRef.current === token) setConsultando(false);
    }
  };

  // El candado va en un ref y no en el estado: dos clics en el mismo fotograma
  // leerían `abriendo` todavía en false y crearían el lead dos veces. El botón
  // deshabilitado protege del tercer clic, no del segundo.
  const abriendoRef = useRef(false);
  const abrir = async () => {
    if (abriendoRef.current) return;
    abriendoRef.current = true;
    setAbriendo(true);
    try {
      const r = await abrirClienteParaVenta({ storeId, phone, nombre });
      setRes(r);
      if (!r.ok || !r.leadId) return;
      // A la gaveta de siempre. Desde ahí, «Generar pedido» es el mismo botón
      // que usa toda la cola. Si falla, la tarjeta se queda abierta: el aviso de
      // la cola dice qué pasó y el teléfono escrito no se pierde.
      if (!(await onAbrir(r.leadId))) return;
      cerrar();
      // La lista todavía no sabe del lead nuevo. Se refresca DESPUÉS de abrir la
      // ficha, así que su costo no lo paga nadie mirando una pantalla quieta.
      router.refresh();
    } catch {
      setRes({ok:false,error:"No se pudo abrir la ficha del cliente. Lo escrito se conserva; intenta nuevamente."});
    } finally {
      abriendoRef.current = false;
      setAbriendo(false);
    }
  };

  const cerrarPanel = () => {
    if (!abriendo) cerrar();
  };
  // Escape cierra el panel, como la ficha; mientras abre la ficha, no.
  const cerrarRef = useRef(cerrarPanel);
  cerrarRef.current = cerrarPanel;
  useEffect(() => {
    if (!abierto) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) cerrarRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [abierto]);
  const candidatos = res?.ok && !res.existia ? (res.candidatos ?? []) : [];

  return (
    <>
      <OpsButton onClick={() => {
        if (defaultStoreId) setStoreId(defaultStoreId);
        setAbierto(true); onOpenChange?.(true);
      }} aria-haspopup="dialog" aria-expanded={abierto} className="pointer-coarse:h-11">
        <IconPhone />
        Venta por teléfono
      </OpsButton>
      {abierto && (
        <SidePanel
          label="Venta por teléfono"
          title="Venta por teléfono"
          meta="Cliente que no está en la cola"
          width="max-w-[480px]"
          onClose={cerrarPanel}
        >
          <div className="flex flex-col gap-4">
            <p className="text-[13px] text-ink-600">
              Para un cliente que no está en la cola: llamó o escribió por otro lado. Se abre su ficha y desde ahí se
              genera el pedido, como cualquier otro.
            </p>

            {stores.length > 1 && (
              <div role="group" aria-label="Tienda">
                <span className="text-[13px] font-medium text-ink-700">Tienda</span>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {stores.map((s) => (
                    <ChoiceChip
                      key={s.id}
                      label={s.name}
                      active={storeId === s.id}
                      onClick={() => {
                        if (abriendo) return;
                        setStoreId(s.id);
                        ++consultaRef.current; setConsultando(false);
                        setRes(null); // el aviso es de OTRA tienda: dejaría de ser cierto
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            <label className="block">
              <span className="flex items-baseline justify-between gap-2 text-[13px] font-medium text-ink-700">
                Celular
                {consultando ? (
                  <span className="flex items-center gap-1 text-xs font-normal text-ink-500" role="status">
                    <Spinner />
                    Consultando…
                  </span>
                ) : res?.ok && !res.existia ? (
                  <span className="text-xs font-normal text-ink-500">No está en la cola</span>
                ) : null}
              </span>
              <input
                value={phone}
                disabled={abriendo}
                onChange={(e) => {
                  setPhone(e.target.value);
                  ++consultaRef.current; setConsultando(false);
                  setRes(null);
                }}
                onBlur={() => {
                  if (phone.trim()) void consultar();
                }}
                placeholder="999 888 777"
                inputMode="tel"
                className={`${FIELD} mt-1 tabular-nums pointer-coarse:h-11`}
              />
            </label>

            <label className="block">
              <span className="flex items-baseline justify-between gap-2 text-[13px] font-medium text-ink-700">
                Nombre
                <span className="text-xs font-normal text-ink-500">opcional</span>
              </span>
              <input
                value={nombre}
                disabled={abriendo}
                onChange={(e) => setNombre(e.target.value)}
                placeholder="Cómo se llama"
                className={`${FIELD} mt-1 pointer-coarse:h-11`}
              />
            </label>

            {(res?.error || openingError) && (
              <Banner tone="crit" role="alert">
                {res?.error || openingError}
              </Banner>
            )}
            {res?.ok && res.existia && (
              <Banner tone="info">
                Este cliente <strong className="font-semibold">ya está en la cola</strong>
                {res.nombre ? ` como ${res.nombre}` : ""}. Se abre su ficha en vez de crear otra.
              </Banner>
            )}

            {/* ¿Es alguno de estos? Un cliente que escribió con nombre de usuario
                de WhatsApp no trae teléfono, así que la búsqueda por número NO lo
                encuentra y seguir de largo crearía un segundo lead: el cliente
                queda partido en dos y la venta se le quita al anuncio que lo trajo
                (ver lib/lead-sin-numero.ts). Se ofrece antes de crear nada. */}
            {res && candidatos.length > 0 && (
              <section className="rounded-lg bg-warn-wash p-3">
                <p className="text-[13px] font-semibold text-warn-fg">
                  Ese número no está en la cola. ¿Es alguna de estas conversaciones?
                </p>
                <p className="mt-0.5 text-[13px] text-ink-700">
                  Escribieron con nombre de usuario, así que WhatsApp no nos dio su celular. Si abres la suya, la venta
                  se queda con su anuncio y su historial.
                </p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {ordenarCandidatos(res.candidatos ?? [], nombre).map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        disabled={abriendo}
                        onClick={() => {
                          void (async () => {
                            if(abriendoRef.current)return;
                            abriendoRef.current=true;setAbriendo(true);
                            try { if (await onAbrir(c.id)) cerrar(); }
                            catch {setRes({ok:false,error:"No se pudo abrir la conversación. Intenta nuevamente."});}
                            finally {abriendoRef.current=false;setAbriendo(false);}
                          })();
                        }}
                        className="flex w-full items-center justify-between gap-3 rounded-md bg-white px-3 py-2 text-left shadow-control ring-1 ring-line transition-colors hover:bg-wash disabled:opacity-60 pointer-coarse:min-h-11"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-ink-900">{etiquetaCandidato(c)}</span>
                          {c.adHeadline && <span className="block truncate text-xs text-ink-500">{c.adHeadline}</span>}
                        </span>
                        <span className="flex shrink-0 items-center gap-1 text-[13px] font-medium text-brand-700">
                          Abrir su ficha
                          <IconChevronRight className="size-4" />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {res?.aviso && <Aviso aviso={res.aviso} />}

            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <OpsButton
                variant="primary"
                size="lg"
                className="w-full"
                disabled={abriendo || !phone.trim() || !storeId}
                aria-busy={abriendo}
                onClick={() => void abrir()}
              >
                {abriendo && <Spinner />}
                {abriendo
                  ? "Abriendo la ficha…"
                  : candidatos.length > 0
                    ? "No es ninguna: crear y abrir la ficha"
                    : res?.aviso?.riesgo === "duplicado"
                      ? "Abrir su ficha de todas formas"
                      : res?.ok && res.existia
                        ? "Abrir su ficha"
                        : "Abrir y generar pedido"}
              </OpsButton>
              {/* Decir POR QUÉ tarda, no solo que tarda: el que espera sabiendo
                  qué se está haciendo espera; el que mira un botón mudo vuelve a
                  pulsarlo. */}
              <p className="text-center text-xs text-ink-500" aria-live="polite">
                {abriendo
                  ? "Creando la ficha del cliente y abriéndola. Un momento…"
                  : "Se abre la ficha de siempre, con «Generar pedido»."}
              </p>
            </div>
          </div>
        </SidePanel>
      )}
    </>
  );
}
