"use client";

// «Distrito por revisar» antes de crear la guía (MOM §19.0.3, owner 08-11-2026).
//
// #KP202409 llegó con distrito «Arequipa» y dirección «AV solo 709 campo marte
// paucarpata»: Kapta le pasó «Arequipa» a Swayp, que fue al cercado y anuló la
// guía. Antes de crear una guía (Swayp directa, «Swayp lo puede llevar hoy»,
// reenvío por Swayp, Aliclik y la salida Olva) se avisa en ámbar, con un botón
// por distrito que menciona la dirección. Corregir usa el MISMO guardado de
// «Corregir ubicación» (`updateOrderGeo`), con solo el distrito y su nota, y
// recarga. Crear igual sigue siendo posible, pero solo tras «Crear con
// Arequipa igual»: es un aviso, no un estado ni un bloqueo del servidor.

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Banner, OpsButton } from "@/components/ops-ui";
import { loadOrderGeo, updateOrderGeo, type MasterActionState } from "@/app/dashboard/pedidos/actions";
import {
  loadDistrictMismatchForGuide,
  type GuideDestinationInput,
} from "@/app/dashboard/pedidos/district-mismatch-actions";
import {
  districtFixLabel,
  districtFixNote,
  districtKeepLabel,
  districtMismatchText,
  type DistrictMismatch,
} from "@/lib/district-mismatch";

/**
 * Corrige el distrito con el guardado de siempre (`updateOrderGeo`). Si el
 * pedido ya tenía una corrección (una coordenada, otra dirección), se conserva
 * entera: `updateOrderGeo` reescribe la fila y solo cambia lo que se le pasa.
 */
export async function applyDistrictFix(orderId: string, district: string): Promise<MasterActionState> {
  const current = await loadOrderGeo(orderId).catch(() => null);
  const keep = current?.hasOverride
    ? {
        region: current.region ?? null,
        province: current.province ?? null,
        address: current.address ?? null,
        reference: current.reference ?? null,
        latitude: current.latitude ?? null,
        longitude: current.longitude ?? null,
      }
    : {};
  return updateOrderGeo(orderId, { ...keep, district, note: districtFixNote(district) });
}

export interface DistrictMismatchCheck {
  mismatch: DistrictMismatch | null;
  /** Quien crea pulsó «Crear con … igual». */
  acknowledged: boolean;
  /** Hay aviso sin atender: el botón de crear espera. */
  blocking: boolean;
  acknowledge: () => void;
  reload: () => void;
}

/**
 * Lee el aviso de UN pedido: al abrir y tras corregir (sin sondeo).
 * `destination` es el destino con que saldrá la guía cuando no es el del
 * Master (el reenvío por Swayp usa el de la salida anterior).
 */
export function useDistrictMismatchCheck(
  orderId: string | null | undefined,
  destination?: GuideDestinationInput | null,
): DistrictMismatchCheck {
  const [mismatch, setMismatch] = useState<DistrictMismatch | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [version, setVersion] = useState(0);
  const destinationKey = JSON.stringify(destination ?? null);

  useEffect(() => {
    setAcknowledged(false);
  }, [orderId]);

  useEffect(() => {
    if (!orderId) {
      setMismatch(null);
      return;
    }
    let alive = true;
    loadDistrictMismatchForGuide(orderId, destination ?? null)
      .then((m) => {
        if (alive) setMismatch(m);
      })
      .catch(() => {
        /* sin lectura no hay aviso: la guía se crea como siempre */
      });
    return () => {
      alive = false;
    };
    // `destinationKey` resume `destination`: un objeto nuevo con lo mismo no relee.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, destinationKey, version]);

  return {
    mismatch,
    acknowledged,
    blocking: !!mismatch && !acknowledged,
    acknowledge: () => setAcknowledged(true),
    reload: () => setVersion((v) => v + 1),
  };
}

/** El texto del porqué del botón de crear mientras el aviso espera. */
export const DISTRICT_MISMATCH_BLOCK_REASON = "Revisa el distrito, arriba: corrígelo o confirma que sale igual.";

/**
 * El aviso ámbar (DESIGN.md: `warn-wash` de fondo, título en `warn-fg`) con un
 * «Corregir a …» por distrito y «Crear con … igual».
 */
export function DistrictMismatchWarning({
  orderId,
  check,
  onCorrected,
  afterFixNote,
  className,
}: {
  orderId: string;
  check: DistrictMismatchCheck;
  /** Tras corregir: recargar la vista previa de la guía, abrir otro editor… */
  onCorrected?: (district: string) => void;
  /** Una línea más tras corregir, cuando la guía usa otro destino (el reenvío). */
  afterFixNote?: string;
  className?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "crit"; text: string } | null>(null);
  const { mismatch } = check;

  if (!mismatch) {
    return message?.tone === "ok" ? (
      <Banner tone="ok" role="status" className={className}>
        {message.text}
      </Banner>
    ) : null;
  }

  const fix = (district: string) => {
    setMessage(null);
    start(async () => {
      const res = await applyDistrictFix(orderId, district);
      if (res.error) {
        setMessage({ tone: "crit", text: res.error });
        return;
      }
      setMessage({
        tone: "ok",
        text: [`Distrito corregido a ${district}.`, afterFixNote].filter(Boolean).join(" "),
      });
      check.reload();
      onCorrected?.(district);
      router.refresh();
    });
  };

  return (
    <Banner tone="warn" role="alert" title={districtMismatchText(mismatch)} className={className}>
      <p>
        {check.acknowledged
          ? `La guía saldrá con el distrito ${mismatch.current}, como pediste.`
          : `Con ${mismatch.current} el courier va a la capital y puede anular la guía. Corrige el distrito antes de crearla.`}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {mismatch.suggested.map((district) => (
          <OpsButton
            key={district}
            size="sm"
            variant="primary"
            onClick={() => fix(district)}
            disabled={pending}
            className="pointer-coarse:h-11"
          >
            {pending ? "Corrigiendo…" : districtFixLabel(district)}
          </OpsButton>
        ))}
        {!check.acknowledged && (
          <OpsButton size="sm" onClick={check.acknowledge} disabled={pending} className="pointer-coarse:h-11">
            {districtKeepLabel(mismatch)}
          </OpsButton>
        )}
      </div>
      {/* El reenvío corrige el pedido pero sale con el destino de la salida:
          el aviso sigue y la frase dice qué falta. */}
      {message && (
        <p
          role={message.tone === "crit" ? "alert" : "status"}
          className={`mt-2 text-[13px] font-medium leading-5 ${message.tone === "crit" ? "text-crit-fg" : "text-ok-fg"}`}
        >
          {message.text}
        </p>
      )}
    </Banner>
  );
}
