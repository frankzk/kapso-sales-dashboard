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

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, cn } from "@/components/ui";
import {
  abrirClienteParaVenta,
  consultarClientePorTelefono,
  type ClienteParaVenta,
} from "@/app/dashboard/leads/venta-telefonica-actions";
import { cuandoLabel, RIESGO_TITULO, type AvisoDuplicado } from "@/lib/pedido-duplicado";

const TONO: Record<string, string> = {
  duplicado: "border-red-200 bg-red-50 text-red-800",
  revisar: "border-amber-200 bg-amber-50 text-amber-800",
  recompra: "border-sky-200 bg-sky-50 text-sky-800",
};

function Aviso({ aviso }: { aviso: AvisoDuplicado }) {
  if (aviso.riesgo === "ninguno") return null;
  const p = aviso.pedido;
  return (
    <div className={cn("rounded-lg border px-3 py-2 text-xs", TONO[aviso.riesgo])}>
      <p className="font-semibold">{RIESGO_TITULO[aviso.riesgo]}</p>
      <p className="mt-0.5">
        {p.name ?? "Pedido"} · {cuandoLabel(aviso.horas)}
        {p.total_amount != null && ` · S/ ${p.total_amount.toFixed(2)}`}
        {p.general_status && ` · ${p.general_status.replace(/_/g, " ")}`}
      </p>
      {p.titulos.length > 0 && (
        <p className="mt-0.5 opacity-80">{p.titulos.slice(0, 3).join(", ")}</p>
      )}
      {aviso.riesgo === "duplicado" && (
        <p className="mt-1 font-medium">
          Revisa ese pedido antes de crear otro: puede ser la misma venta dos veces.
        </p>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" opacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function VentaTelefonica({
  stores,
  defaultStoreId,
  onAbrir,
}: {
  stores: { id: string; name: string }[];
  defaultStoreId?: string | null;
  /** Abre la ficha del lead en la gaveta. Resuelve cuando ya tiene datos. */
  onAbrir: (leadId: string) => Promise<boolean>;
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
    setAbierto(false);
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
  const consultar = async () => {
    const token = ++consultaRef.current;
    setConsultando(true);
    try {
      const r = await consultarClientePorTelefono(storeId, phone);
      if (consultaRef.current === token) setRes(r);
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
    } finally {
      abriendoRef.current = false;
      setAbriendo(false);
    }
  };

  if (!abierto) {
    return (
      <button
        type="button"
        onClick={() => setAbierto(true)}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100"
      >
        ＋ Venta por teléfono
      </button>
    );
  }

  return (
    <Card className="w-full space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Venta de un cliente que no está en la cola</h3>
        <button
          type="button"
          onClick={cerrar}
          disabled={abriendo}
          className="text-slate-400 hover:text-slate-700 disabled:opacity-40"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">
          Tienda
          <select
            value={storeId}
            disabled={abriendo}
            onChange={(e) => {
              setStoreId(e.target.value);
              setRes(null); // el aviso es de OTRA tienda: dejaría de ser cierto
            }}
            className="mt-0.5 block w-44 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-slate-800"
          >
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          <span className="flex items-center gap-1.5">
            Celular
            {consultando && (
              <span className="flex items-center gap-1 text-slate-400">
                <Spinner />
                Consultando…
              </span>
            )}
          </span>
          <input
            value={phone}
            disabled={abriendo}
            onChange={(e) => {
              setPhone(e.target.value);
              setRes(null);
            }}
            onBlur={() => {
              if (phone.trim()) void consultar();
            }}
            placeholder="999888777"
            inputMode="tel"
            className="mt-0.5 block w-40 rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-50"
          />
        </label>
        <label className="text-xs text-slate-500">
          Nombre <span className="text-slate-400">(opcional)</span>
          <input
            value={nombre}
            disabled={abriendo}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Cómo se llama"
            className="mt-0.5 block w-48 rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-50"
          />
        </label>
        <button
          type="button"
          disabled={abriendo || !phone.trim() || !storeId}
          aria-busy={abriendo}
          onClick={() => void abrir()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {abriendo && <Spinner />}
          {abriendo ? "Abriendo la ficha…" : "Abrir y generar pedido"}
        </button>
      </div>

      {/* Decir POR QUÉ tarda, no solo que tarda: el que espera sabiendo qué se
          está haciendo espera; el que mira un botón mudo vuelve a pulsarlo. */}
      {abriendo && (
        <p className="text-xs text-slate-500">
          Creando la ficha del cliente y abriendo su gaveta. Un momento…
        </p>
      )}

      {res?.error && <p className="text-xs text-red-600">{res.error}</p>}
      {res?.ok && res.existia && (
        <p className="text-xs text-slate-600">
          Este cliente <strong>ya está en la cola</strong>
          {res.nombre ? ` como ${res.nombre}` : ""}. Se abre su ficha en vez de crear otra.
        </p>
      )}
      {res?.aviso && <Aviso aviso={res.aviso} />}
    </Card>
  );
}
