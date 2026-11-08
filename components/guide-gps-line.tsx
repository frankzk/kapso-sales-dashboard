// «GPS enviado a Aliclik: -13.53382, -71.92565 · Ver en Maps · GPS de la entrega
// de #KP131756», en la Actividad y en «Salidas y guías» de la ficha (MOM §25,
// 08-11-2026). Es el punto que Kapta le mandó a Aliclik, no el GPS del
// motorizado: lo dice el rótulo. Las reglas y el origen, en lib/guide-gps.ts.

import { cn } from "@/components/ui";
import { formatGpsCoordinate, gpsMapsUrl, gpsSourceLabel, GUIDE_GPS_PREFIX, type GuideGps } from "@/lib/guide-gps";

export function GuideGpsLine({ gps, className }: { gps: GuideGps; className?: string }) {
  const source = gpsSourceLabel(gps);
  return (
    <p className={cn("text-[13px] leading-5 text-ink-600", className)}>
      {GUIDE_GPS_PREFIX}:{" "}
      <span className="font-mono tabular-nums text-ink-900">{formatGpsCoordinate(gps.lat, gps.lng)}</span>
      {" · "}
      <a
        href={gpsMapsUrl(gps.lat, gps.lng)}
        target="_blank"
        rel="noreferrer noopener"
        className="font-medium text-brand-700 hover:underline"
      >
        Ver en Maps
      </a>
      {source ? ` · ${source}` : ""}
    </p>
  );
}
