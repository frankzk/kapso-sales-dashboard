"use client";

// «Guías de Swayp que Kapta no tiene» en Envíos (MOM §11.2, 26-10-2026, 0282):
// Swayp avisó de una guía —casi siempre una entrega— que nadie registró en
// Kapta, porque se creó directo en su panel. Mientras no se registre, el pedido
// sigue «Por despachar» aunque ya se entregó (#KP143754). La tarjeta dice cuál
// es, sugiere el pedido y cómo registrarla; «Descartar» si no es nuestra.

import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD_BOX, OpsButton, SECTION_CARD, SectionHead, type BadgeTone } from "@/components/ops-ui";
import { CopyButton } from "@/components/copy-button";
import { dismissSwaypUnknownGuide } from "@/app/dashboard/envios/actions";
import { orderDrawerHref } from "@/lib/order-drawer-href";
import type { SwaypUnknownGuide } from "@/lib/swayp-unknown-guides-access";

const LIMA = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function limaStamp(iso: string): string {
  const parts = Object.fromEntries(LIMA.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.day}-${parts.month} ${parts.hour}:${parts.minute}`;
}

/** El tono del estado de Swayp: entregada en verde, devolución o novedad en ámbar. */
function stateTone(state: number): BadgeTone {
  if (state === 7) return "ok";
  if (state === 6 || state === 8 || state === 9 || state === 12) return "warn";
  if (state === 10) return "neutral";
  return "info";
}

function GuideRow({ guide }: { guide: SwaypUnknownGuide }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [dismissing, setDismissing] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const contact = [guide.customerName, guide.customerPhone ? `+${guide.customerPhone}` : null].filter(Boolean).join(" · ");
  const confirmDismiss = () =>
    startTransition(async () => {
      setError(null);
      const res = await dismissSwaypUnknownGuide(guide.guideNumber, note);
      if (res.error) setError(res.error);
      else router.refresh();
    });

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-mono text-sm font-semibold tabular-nums text-ink-900">{guide.guideNumber}</span>
        <CopyButton value={guide.guideNumber} label="el número de guía" />
        <Badge tone={stateTone(guide.state)}>{guide.stateLabel}</Badge>
        <span className="text-[13px] tabular-nums text-ink-500">
          Swayp avisó el {limaStamp(guide.lastSeenAt)}
          {guide.notices > 1 ? ` · ${guide.notices} avisos` : ""}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] leading-5">
        {contact && <span className="text-ink-700">{contact}</span>}
        {guide.reference && !guide.suggestion && <span className="text-ink-500">Ref.: {guide.reference}</span>}
        {guide.suggestion ? (
          <Link
            href={orderDrawerHref(guide.suggestion.orderId, "operar", { pathname, search: search.toString() })}
            className="font-medium text-brand-700 hover:underline"
          >
            Abrir {guide.suggestion.orderName}
            <span className="font-normal text-ink-500">
              {guide.suggestion.by === "pedido" ? " · la guía lo nombra" : " · mismo celular"}
            </span>
          </Link>
        ) : (
          <span className="text-ink-500">Sin pedido sugerido: búscalo por el celular o el nombre.</span>
        )}
        <span className="ml-auto">
          {!dismissing && (
            <OpsButton variant="ghost" size="sm" onClick={() => setDismissing(true)}>
              Descartar
            </OpsButton>
          )}
        </span>
      </div>
      {dismissing && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Por qué (no es nuestra, ya se registró…)"
            className={cn(FIELD_BOX, "h-8 w-full max-w-sm px-3 text-[13px] sm:w-80")}
            aria-label={`Motivo para descartar la guía ${guide.guideNumber}`}
          />
          <OpsButton size="sm" onClick={confirmDismiss} disabled={pending}>
            {pending ? "Descartando…" : "Descartar aviso"}
          </OpsButton>
          <OpsButton variant="ghost" size="sm" onClick={() => setDismissing(false)} disabled={pending}>
            Cancelar
          </OpsButton>
        </div>
      )}
      {error && <p className="text-[13px] text-crit-fg">{error}</p>}
    </li>
  );
}

export function SwaypUnknownGuides({ guides }: { guides: SwaypUnknownGuide[] }) {
  if (!guides.length) return null;
  return (
    <section aria-labelledby="swayp-desconocidas-title" className={cn("space-y-4", SECTION_CARD)}>
      <SectionHead
        id="swayp-desconocidas-title"
        title="Guías de Swayp que Kapta no tiene"
        badge={<Badge tone="warn">{guides.length}</Badge>}
        help="Swayp avisó de estas guías y Kapta no las tiene: se crearon en su panel sin registrarlas aquí. Mientras tanto el pedido no avanza aunque ya se entregó."
      />
      <Banner tone="info">
        Para registrarla, abre el pedido → <span className="font-semibold">Operar</span> → ruta{" "}
        <span className="font-semibold">Swayp</span> → escribe el número en «N° de guía Swayp». Con el número escrito no
        se crea otra guía; Kapta lee su estado y la tarjeta la quita sola.
      </Banner>
      <ul className="divide-y divide-line">
        {guides.map((g) => (
          <GuideRow key={g.guideNumber} guide={g} />
        ))}
      </ul>
    </section>
  );
}
