"use client";

// Después de «Generar pedido» en Leads: cómo sale y cómo se cobra el pedido
// recién creado (MOM §25.2, owner 07-11-2026).
//
// Tres opciones a la vista, en tarjetas-opción (DESIGN.md «Tarjeta-opción»):
// «Guía Aliclik», «Swayp hoy» y «Agencia Shalom + adelanto». La elegida abre
// debajo, en su propia tarjeta, EL MISMO componente que usa la ficha del pedido,
// con sus mismas server actions:
//   - Aliclik → `AliclikGuidePanel` (lo que el cajón ya enseñaba);
//   - Swayp → «Swayp lo puede llevar hoy» (`EnviarPorSwaypDesdeConfirmacion`)
//     que abre la guía Swayp directa (`DirectFenixGuideModal`, `por_confirmar`);
//   - Agencia → la tarjeta de Cobro (`PickupKeyPanel`): «Registrar un pago» con
//     el comprobante del adelanto y «DNI y agencia Shalom».
// No hay versión «de Leads» de ninguna: crear desde aquí o desde la ficha
// escribe las mismas filas. Qué se ofrece lo decide `loadLeadPostOrderChoices`
// con las reglas de la ficha (lib/lead-post-order.ts); lo que no se ofrece dice
// por qué en una línea, apagado, en vez de desaparecer.
//
// Va en la columna del cajón y no en un modal a propósito, como el panel de
// Aliclik: la vendedora sigue viendo la conversación de WhatsApp —de ahí salen
// la ubicación, el DNI y el comprobante—.

import { useCallback, useEffect, useId, useState, useTransition } from "react";
import { AliclikGuidePanel } from "@/components/aliclik-guide-panel";
import { DirectFenixGuideModal } from "@/components/direct-fenix-guide-modal";
import { PickupKeyPanel } from "@/components/pickup-key-panel";
import { EnviarPorSwaypDesdeConfirmacion } from "@/components/swayp-desde-confirmacion-offer";
import { Badge, Banner, OpsButton, OptionTile, SECTION_CARD, SectionHead, Skeleton } from "@/components/ops-ui";
import { loadLeadPostOrderChoices } from "@/app/dashboard/leads/post-order-actions";
import {
  defaultLeadPostOrderChoice,
  type LeadPostOrderChoiceKey,
  type LeadPostOrderChoices as Choices,
} from "@/lib/lead-post-order";
import { subscribePaymentPanelChange } from "@/lib/payment-panel-sync";
import type { CustomerHistory } from "@/lib/leads-access";

export function LeadPostOrderChoices({
  leadId,
  history,
  onChanged,
}: {
  leadId: string;
  /**
   * El historial del lead: trae el panel de Aliclik tal como lo pinta hoy (su
   * `currentOrderId` llega en null sin `aliclik.create_guide`) y, al cambiar,
   * vuelve a pedir las opciones —un pedido nuevo, una guía creada—.
   */
  history: CustomerHistory;
  /** Lo que una acción cambió toca el lead y su historial: el cajón los recarga. */
  onChanged: () => void;
}) {
  const [choices, setChoices] = useState<Choices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  // Lo que eligió la asesora, atado al pedido: «Generar nuevo pedido» empieza
  // otra vez por la opción de ese pedido.
  const [picked, setPicked] = useState<{ orderId: string; key: LeadPostOrderChoiceKey | null } | null>(null);
  const [swaypOpen, setSwaypOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const headingId = useId();
  const source = useId();

  useEffect(() => {
    let alive = true;
    startTransition(async () => {
      try {
        const res = await loadLeadPostOrderChoices(leadId);
        if (!alive) return;
        if ("error" in res) setError(res.error);
        else {
          setChoices(res.choices);
          setError(null);
        }
      } catch {
        if (alive) setError("No se pudieron cargar las opciones de envío. Revisa la conexión y vuelve a intentarlo.");
      } finally {
        if (alive) setLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
    // `history` cambia cuando el cajón recarga lo del lead: un pedido nuevo o
    // una guía creada cambian lo que se ofrece.
  }, [leadId, history, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const changed = useCallback(() => {
    reload();
    onChanged();
  }, [reload, onChanged]);

  // Un pago registrado o el DNI y la agencia guardados en la tarjeta de Cobro
  // cambian la chapa de la opción (lib/payment-panel-sync.ts).
  const orderId = choices?.orderId ?? null;
  useEffect(() => (orderId ? subscribePaymentPanelChange(orderId, source, reload) : undefined), [orderId, source, reload]);

  // Sin pedido propio no hay nada que elegir.
  if (loaded && !error && !choices) return null;

  // FALLÓ LA CARGA: se dice, con reintento, y Aliclik se queda como estaba
  // antes de esta tarjeta para que la venta no se frene por una lectura.
  if (error && !choices) {
    return (
      <>
        <section aria-labelledby={headingId} className={SECTION_CARD}>
          <SectionHead id={headingId} title="Cómo sale el pedido" />
          <div className="mt-4 space-y-3">
            <Banner tone="crit" role="alert">
              {error}
            </Banner>
            <OpsButton size="sm" onClick={reload} disabled={pending} className="pointer-coarse:h-11">
              Intentar nuevamente
            </OpsButton>
          </div>
        </section>
        <AliclikContent history={history} guide={history.currentOrderGuide} onCreated={changed} />
      </>
    );
  }

  if (!choices) {
    return (
      <section aria-labelledby={headingId} aria-busy="true" className={SECTION_CARD}>
        <SectionHead id={headingId} title="Cómo sale el pedido" />
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      </section>
    );
  }

  const active: LeadPostOrderChoiceKey | null =
    picked && picked.orderId === choices.orderId ? picked.key : defaultLeadPostOrderChoice(choices);
  const choose = (key: LeadPostOrderChoiceKey) =>
    setPicked({ orderId: choices.orderId, key: active === key ? null : key });

  const { aliclik, swayp, agencia } = choices;
  const why = (reason: string | null) => <span className="text-warn-fg">{reason}</span>;

  return (
    <>
      <section aria-labelledby={headingId} className={SECTION_CARD}>
        <SectionHead
          id={headingId}
          title="Cómo sale el pedido"
          badge={choices.orderName ? <Badge>{choices.orderName}</Badge> : undefined}
          help="Elige por dónde sale y, si la clienta manda adelanto, regístralo aquí. Son las mismas acciones de la ficha del pedido."
        />
        {error && (
          <Banner tone="crit" role="alert" className="mt-4">
            {error}
          </Banner>
        )}
        {/* Una columna en el teléfono; tres desde 640 px. */}
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <OptionTile
            label="Guía Aliclik"
            active={active === "aliclik"}
            disabled={!aliclik.offered && !aliclik.guide}
            badge={aliclik.guide ? <Badge tone="ok">Creada</Badge> : undefined}
            description={
              aliclik.guide ? (
                <span className="break-all font-mono">{aliclik.guide}</span>
              ) : aliclik.offered ? (
                "Contra entrega por Aliclik: cotiza y crea la guía."
              ) : (
                why(aliclik.reason)
              )
            }
            onClick={() => choose("aliclik")}
          />
          <OptionTile
            label="Swayp hoy"
            active={active === "swayp"}
            disabled={!swayp.offered && !swayp.guides.length}
            badge={
              swayp.guides.length ? (
                <Badge tone="ok">Programado</Badge>
              ) : swayp.offered ? (
                <Badge>Sin confirmar</Badge>
              ) : undefined
            }
            description={
              swayp.guides.length ? (
                <span className="break-all font-mono">{swayp.guides.join(", ")}</span>
              ) : swayp.offered ? (
                "Sale sin confirmar; si no lo entrega, vuelve a Por confirmar."
              ) : (
                why(swayp.reason)
              )
            }
            onClick={() => choose("swayp")}
          />
          <OptionTile
            label="Agencia Shalom + adelanto"
            active={active === "agencia"}
            disabled={!agencia.offered}
            badge={
              agencia.payment ? (
                <Badge tone="info" wrap>
                  {agencia.payment}
                </Badge>
              ) : agencia.shalom ? (
                <Badge tone="ok">Agencia guardada</Badge>
              ) : undefined
            }
            description={
              agencia.offered
                ? (agencia.shalom ?? "DNI, agencia de destino y el comprobante del adelanto.")
                : why(agencia.reason)
            }
            onClick={() => choose("agencia")}
          />
        </div>
      </section>

      {active === "aliclik" && <AliclikContent history={history} guide={aliclik.guide} onCreated={changed} />}

      {active === "swayp" && (
        <section aria-label="Swayp hoy" className={SECTION_CARD}>
          <SectionHead
            title="Swayp hoy"
            badge={swayp.guides.length ? <Badge tone="ok">Programado</Badge> : undefined}
          />
          {swayp.guides.length ? (
            <Banner tone="ok" role="status" title="Swayp programado" className="mt-4">
              <p className="mt-0.5">
                Guía <span className="break-all font-mono font-semibold">{swayp.guides.join(", ")}</span>. Sale sin
                confirmar: si Swayp no lo entrega, el pedido vuelve a Por confirmar para llamarlo otra vez.
              </p>
            </Banner>
          ) : (
            <EnviarPorSwaypDesdeConfirmacion className="mt-4" pending={pending} onOpen={() => setSwaypOpen(true)} />
          )}
        </section>
      )}

      {active === "agencia" && agencia.offered && (
        <div className={SECTION_CARD}>
          <PickupKeyPanel
            key={choices.orderId}
            orderId={choices.orderId}
            mode={agencia.mode}
            gatewayNote={agencia.gatewayNote}
            shalomDestination={agencia.shalomDestination}
            onChanged={changed}
          />
        </div>
      )}

      {swaypOpen && (
        <DirectFenixGuideModal
          initialOrderId={choices.orderId}
          origen="por_confirmar"
          onClose={() => setSwaypOpen(false)}
          onCreated={() => {
            setPicked({ orderId: choices.orderId, key: "swayp" });
            changed();
          }}
        />
      )}
    </>
  );
}

/**
 * Aliclik: la guía ya creada, como bloque permanente (los dos códigos juntos
 * —el pedido de la tienda y la guía— son los que hay que cruzar si algo se
 * tuerce), o el panel para crearla. Es el que el cajón enseñaba antes.
 */
function AliclikContent({
  history,
  guide,
  onCreated,
}: {
  history: CustomerHistory;
  guide: string | null;
  onCreated: () => void;
}) {
  if (guide) {
    return (
      <section aria-label="Guía de Aliclik" className={SECTION_CARD}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-ink-900">Guía de Aliclik</h3>
          <Badge tone="ok">Creada</Badge>
        </div>
        <p className="mt-2 break-all font-mono text-sm font-semibold text-ink-900">{guide}</p>
        {history.currentOrderName && (
          <p className="mt-0.5 text-[13px] text-ink-500">Pedido {history.currentOrderName}</p>
        )}
      </section>
    );
  }
  // `currentOrderId` llega en null sin `aliclik.create_guide` (lo cierra el
  // servidor): sin él, no hay panel.
  if (!history.currentOrderId || history.currentOrderGuide) return null;
  return (
    // El panel trae su contenido sin marco (en la ficha lo enmarca la tarjeta
    // de su sección); aquí lleva su propia tarjeta.
    <div className={SECTION_CARD}>
      <AliclikGuidePanel
        // `key` = candado de identidad. Sin ella, si la vendedora pulsa
        // "Generar nuevo pedido" con el panel abierto, React reutiliza la
        // instancia: cambia `orderId` pero se queda dentro la cotización del
        // pedido ANTERIOR. Crear entonces mandaría a Aliclik el courier y el
        // precio de un pedido y el id de otro.
        key={history.currentOrderId}
        orderId={history.currentOrderId}
        hasCoordinate={history.currentOrderHasCoordinate}
        health={history.currentOrderAliclikHealth}
        onCreated={onCreated}
      />
    </div>
  );
}
