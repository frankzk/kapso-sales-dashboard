import { EmptyState } from "@/components/ui";
import { GfSimulationPanel } from "@/components/gf-simulation-panel";
import { loadGfSimulationStores } from "@/lib/gf-courier-simulate-access";

// Pedidos › Simular GF Courier (MOM §29.17, owner 16-11-2026): qué impide crear la guía de GF en los pedidos de Lima y
// Callao de los últimos 90 días, sin crear ninguna. Solo el owner. Cada pasada de 120 pedidos tarda ~30 s.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export default async function GfSimulacionPage() {
  const ctx = await loadGfSimulationStores();
  if (!ctx) {
    return <EmptyState title="Acceso restringido">La simulación de GF Courier es solo para el dueño de la organización.</EmptyState>;
  }
  if (!ctx.stores.length) {
    return <EmptyState title="Sin token de GF Courier">Guarda el token de GF Courier de la tienda en Ajustes → GF Courier.</EmptyState>;
  }
  return <GfSimulationPanel stores={ctx.stores.map((s) => s.name)} />;
}
