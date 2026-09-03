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

import { useState, useTransition } from "react";
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

export function VentaTelefonica({
  stores,
  defaultStoreId,
}: {
  stores: { id: string; name: string }[];
  defaultStoreId?: string | null;
}) {
  const router = useRouter();
  const [abierto, setAbierto] = useState(false);
  const [busy, start] = useTransition();
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
  const consultar = () =>
    start(async () => setRes(await consultarClientePorTelefono(storeId, phone)));

  const abrir = () =>
    start(async () => {
      const r = await abrirClienteParaVenta({ storeId, phone, nombre });
      setRes(r);
      if (r.ok && r.leadId) {
        cerrar();
        // A la gaveta de siempre. Desde ahí, «Generar pedido» es el mismo botón
        // que usa toda la cola.
        router.push(`/dashboard/leads?open=${r.leadId}`);
        router.refresh();
      }
    });

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
        <button type="button" onClick={cerrar} className="text-slate-400 hover:text-slate-700">
          ✕
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">
          Tienda
          <select
            value={storeId}
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
          Celular
          <input
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              setRes(null);
            }}
            onBlur={() => phone.trim() && consultar()}
            placeholder="999888777"
            inputMode="tel"
            className="mt-0.5 block w-40 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-slate-500">
          Nombre <span className="text-slate-400">(opcional)</span>
          <input
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            placeholder="Cómo se llama"
            className="mt-0.5 block w-48 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="button"
          disabled={busy || !phone.trim() || !storeId}
          onClick={abrir}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
        >
          {busy ? "…" : "Abrir y generar pedido"}
        </button>
      </div>

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
