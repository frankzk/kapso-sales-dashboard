"use client";

import { useMemo } from "react";
import QRCode from "qrcode";

/**
 * QR `tel:` escaneable con la cámara de cualquier teléfono: abre el marcador
 * nativo con el número listo — un tap y está llamando. La asesora trabaja en
 * desktop pero llama desde su celular, y hoy teclea el número a mano (lento y
 * con errores de dedo); escanear elimina el tipeo. La llamada es celular
 * normal, así que queda en el historial del teléfono sola. Generado 100%
 * local (sin servicios externos); el payload es corto (~17 chars) → QR de
 * versión baja que se escanea cómodo incluso chico y a distancia.
 */
export function CallQr({ phone, size = 84 }: { phone: string; size?: number }) {
  const qr = useMemo(() => {
    try {
      const code = QRCode.create(`tel:+${phone}`, { errorCorrectionLevel: "M" });
      const n = code.modules.size;
      let d = "";
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (code.modules.get(r, c)) d += `M${c} ${r}h1v1h-1z`;
        }
      }
      return { n, d };
    } catch {
      return null; // teléfono ilegible → sin QR (el link «llamar» sigue ahí)
    }
  }, [phone]);
  if (!qr) return null;
  const m = 3; // quiet zone en módulos (borde blanco que exige el estándar)
  const box = qr.n + m * 2;
  return (
    <div
      className="flex shrink-0 flex-col items-center gap-0.5"
      title={`Escanea con la cámara del celular para llamar al +${phone}`}
    >
      <svg
        width={size}
        height={size}
        viewBox={`${-m} ${-m} ${box} ${box}`}
        shapeRendering="crispEdges"
        role="img"
        aria-label={`Código QR para llamar al +${phone}`}
        className="rounded-md border border-slate-200 bg-white"
      >
        <rect x={-m} y={-m} width={box} height={box} fill="#ffffff" />
        <path d={qr.d} fill="#0f172a" />
      </svg>
      <span className="text-[10px] font-medium text-slate-400">escanea y llama</span>
    </div>
  );
}
