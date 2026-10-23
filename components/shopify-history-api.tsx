"use client";

// ¿Se puede traer el historial por la API de Shopify en vez de exportar CSV?
// (MOM §37.5). Una consulta de solo lectura con el token de la tienda: cuántos
// pedidos anteriores a 2022 ve. No guarda nada.

import { useState } from "react";
import { Banner, OpsButton } from "@/components/ops-ui";
import { probeShopifyHistoryAccess, type HistoryAccessProbe } from "@/app/dashboard/stores/historial/actions";

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric" });

export function ShopifyHistoryApiProbe({ storeId }: { storeId: string }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<HistoryAccessProbe | { error: string } | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      setResult(await probeShopifyHistoryAccess(storeId));
    } catch (cause) {
      setResult({ error: (cause as Error).message });
    }
    setRunning(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <OpsButton variant="secondary" disabled={running} onClick={run}>
          {running ? "Consultando a Shopify…" : "Probar acceso a pedidos antiguos"}
        </OpsButton>
        <span className="text-[13px] text-ink-500">Solo lee: cuenta los pedidos anteriores a 2022 que Kapta alcanza a ver.</span>
      </div>
      {result && "error" in result && <Banner tone="crit">{result.error}</Banner>}
      {result && !("error" in result) && (
        <Banner tone={result.before2022 > 0 ? "ok" : "warn"}>
          {result.before2022 > 0 ? (
            <>
              Kapta ve {result.before2022AtLeast ? "al menos " : ""}
              {result.before2022.toLocaleString("es-PE")} pedidos anteriores a 2022
              {result.oldest ? ` (el más antiguo, ${result.oldest.name}, del ${fmtDate(result.oldest.createdAt)})` : ""}. Se
              puede traer el historial por API.
            </>
          ) : (
            <>
              Kapta no ve pedidos anteriores a 2022
              {result.oldest ? `: el más antiguo que alcanza es ${result.oldest.name}, del ${fmtDate(result.oldest.createdAt)}` : ""}. Por
              API no se puede; sigue con los CSV.
            </>
          )}
          <span className="mt-1 block text-[12px] opacity-80">Permisos del token: {result.scopes.join(", ") || "—"}</span>
        </Banner>
      )}
    </div>
  );
}
