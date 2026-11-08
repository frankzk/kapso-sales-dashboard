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

import { useCallback, useEffect, useId, useRef, useState } from "react";
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
  expectedOrderId,
  history,
  onChanged,
}: {
  leadId: string;
  /** Pedido actual del lead: una respuesta anterior nunca puede volver a ofrecerlo. */
  expectedOrderId: string | null;
  /**
   * El historial del lead: trae el panel de Aliclik tal como lo pinta hoy (su
   * `currentOrderId` llega en null sin `aliclik.create_guide`) y, al cambiar,
   * vuelve a pedir las opciones —un pedido nuevo, una guía creada—.
   */
  history: CustomerHistory;
  /** Lo que una acción cambió toca el lead y su historial: el cajón los recarga. */
  onChanged: () => void;
}) {
  const targetOrderId = expectedOrderId ?? history.currentOrderId;
  const target = JSON.stringify([leadId, targetOrderId]);
  const [read, setRead] = useState<{
    target: string; choices: Choices | null; error: string | null; loaded: boolean; pending: boolean; orderMismatch?: boolean;
  } | null>(null);
  // La identidad se comprueba DURANTE el render, antes del próximo efecto.
  // Así no queda un panel del pedido anterior mientras llega el nuevo.
  const current = read?.target === target ? read : null;
  const historyOrderMismatch = Boolean(expectedOrderId && history.currentOrderId && expectedOrderId !== history.currentOrderId);
  const choices = historyOrderMismatch ? null : (current?.choices ?? null);
  const error = current?.error ?? (historyOrderMismatch && current?.loaded ? "Los datos del pedido se están actualizando. Vuelve a cargar la ficha para continuar." : null);
  const loaded = current?.loaded ?? false;
  const pending = current?.pending ?? true;
  const [tick, setTick] = useState(0);
  const [picked, setPicked] = useState<{ orderId: string; key: LeadPostOrderChoiceKey | null } | null>(null);
  const [swaypOpenFor, setSwaypOpenFor] = useState<string | null>(null);
  const headingId = useId();
  const source = useId();
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    let alive = true;
    setRead(previous => ({
      target, choices: previous?.target === target ? previous.choices : null,
      error: null, loaded: false, pending: true,
    }));
    // Lectura normal: el estado de carga y el resultado comparten un único
    // contenedor. Una transición no debe conservar otro árbol de esqueletos.
    void loadLeadPostOrderChoices(leadId).then(res => {
      if (!alive) return;
      if ("error" in res) {
        setRead(previous => ({ target, choices: previous?.target === target ? previous.choices : null, error: res.error, loaded: true, pending: false }));
      } else if (targetOrderId && res.choices && res.choices.orderId !== targetOrderId) {
        setRead({ target, choices: null, error: "El pedido cambió. Actualizando la ficha…", loaded: true, pending: false, orderMismatch: true });
        onChangedRef.current();
      } else {
        setRead({ target, choices: res.choices, error: null, loaded: true, pending: false });
      }
    }).catch(() => {
      if (alive) setRead(previous => ({ target, choices: previous?.target === target ? previous.choices : null, error: "No se pudieron cargar las opciones de envío. Revisa la conexión y vuelve a intentarlo.", loaded: true, pending: false }));
    });
    return () => { alive = false; };
    // El historial cambia tras generar otro pedido, crear una guía o registrar
    // un pago. El cleanup descarta respuestas anteriores, incluso del mismo lead.
  }, [leadId, targetOrderId, target, history, tick]);

  const reload = useCallback(() => {
    setTick((n) => n + 1);
    if (historyOrderMismatch) onChangedRef.current();
  }, [historyOrderMismatch]);
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

  const active: LeadPostOrderChoiceKey | null =
    choices ? (picked && picked.orderId === choices.orderId ? picked.key : defaultLeadPostOrderChoice(choices)) : null;
  const choose = (key: LeadPostOrderChoiceKey) =>
    choices && setPicked({ orderId: choices.orderId, key: active === key ? null : key });

  const { aliclik, swayp, agencia } = choices ?? { aliclik: null, swayp: null, agencia: null };
  const why = (reason: string | null) => <span className="text-warn-fg">{reason}</span>;

  return (
    <>
      <section aria-labelledby={headingId} aria-busy={pending} className={SECTION_CARD}>
        <SectionHead
          id={headingId}
          title="Cómo sale el pedido"
          badge={choices?.orderName ? <Badge>{choices.orderName}</Badge> : undefined}
          help={choices ? "Elige por dónde sale y, si la clienta manda adelanto, regístralo aquí. Son las mismas acciones de la ficha del pedido." : undefined}
        />
        {error && (
          <Banner tone="crit" role="alert" className="mt-4">
            <p>{error}</p>
            <OpsButton size="sm" onClick={reload} disabled={pending} className="mt-3 pointer-coarse:h-11">Intentar nuevamente</OpsButton>
          </Banner>
        )}
        {!choices && pending && <div role="status" className="mt-4 grid gap-2 sm:grid-cols-3">
          <span className="sr-only">Cargando opciones de envío…</span>
          <Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" />
        </div>}
        {/* Una columna en el teléfono; tres desde 640 px. */}
        {choices && aliclik && swayp && agencia && (
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
        )}
      </section>

      {choices && aliclik && active === "aliclik" && <AliclikContent history={history} orderId={choices.orderId} orderName={choices.orderName} guide={aliclik.guide} onCreated={changed} />}
      {error && !choices && !historyOrderMismatch && !current?.orderMismatch && targetOrderId && history.currentOrderId === targetOrderId && <AliclikContent history={history} orderId={targetOrderId} orderName={history.currentOrderName} guide={history.currentOrderGuide} onCreated={changed} />}

      {choices && swayp && active === "swayp" && (
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
            <EnviarPorSwaypDesdeConfirmacion className="mt-4" pending={pending} onOpen={() => setSwaypOpenFor(choices.orderId)} />
          )}
        </section>
      )}

      {choices && agencia && active === "agencia" && agencia.offered && (
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

      {choices && swaypOpenFor === choices.orderId && (
        <DirectFenixGuideModal
          initialOrderId={choices.orderId}
          origen="por_confirmar"
          onClose={() => setSwaypOpenFor(null)}
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
  orderId,
  orderName,
  guide,
  onCreated,
}: {
  history: CustomerHistory;
  orderId: string;
  orderName: string | null;
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
        {orderName && (
          <p className="mt-0.5 text-[13px] text-ink-500">Pedido {orderName}</p>
        )}
      </section>
    );
  }
  // `currentOrderId` llega en null sin `aliclik.create_guide` (lo cierra el
  // servidor): sin él, no hay panel.
  if (history.currentOrderId !== orderId || history.currentOrderGuide) return null;
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
        key={orderId}
        orderId={orderId}
        hasCoordinate={history.currentOrderHasCoordinate}
        health={history.currentOrderAliclikHealth}
        onCreated={onCreated}
      />
    </div>
  );
}
