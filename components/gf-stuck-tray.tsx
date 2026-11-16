"use client";

// «Trabados en Grupo GF» (MOM §9.6, owner 15-11-2026): los trabados de las
// cajas y los motorizados de Grupo GF —«Armado sin caja de reparto», «Grupo GF
// lo tomó y no lo puso en caja», «En una caja de un día que pasó», «Grupo GF no
// lo puede llevar» y «En reparto sin resultado del motorizado»— se fueron de
// Repro Lima a Despacho del día, junto a «Sale a reparto». Kenku sigue con el
// reparto propio hasta conectarse a GF Courier por API, y esto tiene que seguir
// funcionando aquí. La lectura es la de Repro Lima y llega después de pintar la
// página (`loadGfStuckOrders`), para no demorar Despacho del día.
import { useEffect, useState } from "react";
import { Banner, Skeleton } from "@/components/ops-ui";
import { LimaStuckTray, type LimaStuckSelection } from "@/components/lima-stuck-tray";
import { loadGfStuckOrders } from "@/app/dashboard/courier/actions";
import { stuckReasonsOf } from "@/lib/lima-stuck";
import type { LimaPendingOrder } from "@/lib/repro-lima-pending";

const GF_REASONS = stuckReasonsOf("grupo_gf");

export function GfStuckTray({ orgId }: { orgId: string }) {
  const [data, setData] = useState<{ rows: LimaPendingOrder[]; today: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<LimaStuckSelection>(null);
  useEffect(() => {
    let alive = true;
    loadGfStuckOrders(orgId)
      .then((result) => {
        if (!alive) return;
        if ("error" in result) setError(result.error);
        else setData(result);
      })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [orgId]);
  if (error) return <Banner tone="warn" role="status" title="No pudimos leer los trabados de Grupo GF">{error}</Banner>;
  if (!data) return <Skeleton className="h-24" />;
  return (
    <LimaStuckTray
      rows={data.rows}
      today={data.today}
      selected={selected}
      onSelect={setSelected}
      reasons={GF_REASONS}
      title="Trabados en Grupo GF"
      intro="Pedidos de Lima quietos en las cajas o con los motorizados de Grupo GF más de lo que deberían."
      footnote="Los días cuentan de lunes a sábado. Lo que es del equipo de la tienda (confirmar, llamar, cerrar o seguir al courier) está en Repro Lima."
    />
  );
}
