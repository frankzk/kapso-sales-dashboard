// Rótulos de envío Tanders, listos para imprimir.
//
// Una página por rótulo: el navegador la manda a la impresora de etiquetas o la
// guarda como PDF (Ctrl+P → Guardar como PDF), que es exactamente lo que hace su
// panel — solo que ahí el PDF lo arma su frontend y acá lo armamos nosotros,
// porque su API no lo expone.
//
// Acepta VARIOS envíos (`?ids=a,b,c`) para que el almacén imprima la tanda del
// día de una sola vez, que es como trabaja.

import QRCode from "qrcode";
import { PrintButton } from "@/components/print-button";
import { createServerSupabase } from "@/lib/db";
import { buildTandersLabel, type LabelShipment } from "@/lib/tanders/label";

export const dynamic = "force-dynamic";

/** QR con el N° de seguimiento, igual que el suyo. */
async function qrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, { margin: 0, width: 320, errorCorrectionLevel: "M" });
}

export default async function RotulosPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const { ids } = await searchParams;
  const shipmentIds = (ids ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!shipmentIds.length) {
    return <Empty>Sin envíos que imprimir.</Empty>;
  }

  // Lectura por RLS: un envío de otra tienda simplemente no aparece, así que la
  // página no puede usarse para leer rótulos ajenos cambiando el id en la URL.
  const sb = await createServerSupabase();
  const { data } = await sb
    .from("shipments")
    .select(
      "id,guide_code,customer_name,customer_phone,delivery_address,delivery_reference,tanders_raw",
    )
    .eq("courier", "tanders")
    .in("id", shipmentIds);

  const rows = (data as (LabelShipment & { id: string })[]) ?? [];
  if (!rows.length) return <Empty>No se encontraron esos envíos, o no tienes acceso.</Empty>;

  // Se respeta el orden en que llegaron los ids: el operador los seleccionó así.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = shipmentIds.map((id) => byId.get(id)).filter(Boolean) as (LabelShipment & {
    id: string;
  })[];

  const labels = await Promise.all(
    ordered.map(async (row) => {
      const label = buildTandersLabel(row);
      return { id: row.id, label, qr: await qrDataUrl(label.trackingCode) };
    }),
  );

  return (
    <>
      {/* Cada rótulo ocupa su propia hoja; la barra de acciones no se imprime. */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .rotulo { page-break-after: always; }
          .rotulo:last-child { page-break-after: auto; }
          body { background: #fff; }
        }
        @page { margin: 10mm; }
      `}</style>

      <div className="no-print mb-4 flex items-center gap-3 print:hidden">
        <PrintButton />
        <span className="text-sm text-slate-500">
          {labels.length} rótulo{labels.length === 1 ? "" : "s"} · Ctrl+P para guardar como PDF
        </span>
      </div>

      <div className="space-y-6">
        {labels.map(({ id, label, qr }) => (
          <div
            key={id}
            className="rotulo mx-auto w-[105mm] border border-slate-300 bg-white text-[11px] text-slate-900"
          >
            <div className="flex items-center justify-between bg-[#FFD400] px-3 py-2">
              <span className="text-sm font-black tracking-tight">TANDER</span>
              <span className="text-[9px] font-semibold tracking-wide">RÓTULO DE ENVÍO</span>
            </div>

            <div className="px-3 py-2">
              <Caption>N° SEGUIMIENTO</Caption>
              <p className="font-mono text-sm font-bold">{label.trackingCode}</p>
            </div>

            <div className="flex justify-center py-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt={label.trackingCode} className="h-[28mm] w-[28mm]" />
            </div>

            <dl className="divide-y divide-slate-200 border-t border-slate-200">
              <Row label="DESTINATARIO" value={label.recipientName} strong />
              <Row label="TELÉFONO" value={label.recipientPhone} strong />
              <Row label="DESTINO" value={label.destination} strong />
              <Row label="ORIGEN" value={label.origin} />
              <Row label="PAQUETE" value={label.packageType} strong />
              <Row label="PESO" value={`${label.weightGrams} g`} strong />
              {label.collectionAmount && (
                <Row label="COBRO" value={`S/ ${label.collectionAmount}`} strong />
              )}
            </dl>

            {label.note && (
              <div className="border-t border-slate-200 px-3 py-2">
                <Caption>NOTA</Caption>
                <p className="whitespace-pre-line">{label.note}</p>
              </div>
            )}

            <div className="flex justify-between border-t border-slate-200 px-3 py-1.5 text-[9px] text-slate-500">
              <span>{label.status}</span>
              <span>{label.createdAt}</span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="text-[8px] font-semibold tracking-wide text-slate-500">{children}</p>;
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex gap-3 px-3 py-1.5">
      <dt className="w-[26mm] shrink-0 text-[8px] font-semibold tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className={strong ? "font-semibold" : ""}>{value || "—"}</dd>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="p-6 text-sm text-slate-500">{children}</p>;
}
