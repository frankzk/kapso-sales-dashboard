"use client";

import { OpsButton } from "@/components/ops-ui";
import { SWAYP_PRIMERO_NOTE, SWAYP_PRIMERO_TITLE } from "@/lib/swayp-desde-confirmacion-offer";

/**
 * «Enviar por Swayp» desde Por confirmar (MOM §11.11). Sale SIN confirmar, por
 * decisión del owner: lo dice el panel, para que nadie lo lea como una
 * confirmación. Si Swayp no entrega, el pedido vuelve a «Por confirmar · Swayp
 * no entregó».
 *
 * Una sola pieza para los dos sitios que la ofrecen: la mesa de confirmación de
 * la ficha del pedido y el paso de después de «Generar pedido» en Leads (MOM
 * §25.2). Quién la ve lo decide `swaypDesdeConfirmacionOffer`; el botón solo
 * abre la guía Swayp directa de siempre (`DirectFenixGuideModal`, con
 * `origen="por_confirmar"`), que valida destino, stock y fecha en el servidor.
 */
export function EnviarPorSwaypDesdeConfirmacion({
  pending,
  onOpen,
  className = "mt-3",
  first = false,
}: {
  pending: boolean;
  onOpen: () => void;
  className?: string;
  /**
   * Pedido nuevo con stock completo en Swayp (MOM §11.14): es la primera
   * opción, va antes de las llamadas y con el botón principal.
   */
  first?: boolean;
}) {
  return (
    <div className={`${className} flex flex-wrap items-center justify-between gap-3 rounded-lg bg-ok-wash p-4`}>
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm font-semibold text-ok-fg">{first ? SWAYP_PRIMERO_TITLE : "Swayp lo puede llevar hoy"}</p>
        <p className="mt-0.5 text-[13px] leading-5 text-ink-700">
          {first
            ? SWAYP_PRIMERO_NOTE
            : "Sale sin confirmar. Si Swayp no lo entrega, el pedido vuelve a Por confirmar para llamarlo otra vez."}
        </p>
      </div>
      <OpsButton
        size="sm"
        variant={first ? "primary" : undefined}
        disabled={pending}
        onClick={onOpen}
        className="pointer-coarse:h-11"
      >
        Enviar por Swayp
      </OpsButton>
    </div>
  );
}
