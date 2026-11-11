"use client";

// La pestaña «Kapso» de la ficha del pedido (MOM §25, 08-11-2026): la
// conversación de WhatsApp de la clienta con el bot de Kapso. Desde el
// 11-11-2026 (owner: «permíteme responder el Kapso desde el drawer») quien
// puede editar el pedido le responde aquí, con la misma caja que Chatby
// (`ReplyBox`): texto, foto, PDF o el ticket Shalom, dentro de las 24 h.
// El owner la pidió al ver que #KP204280 seguía «Pendiente» en Kapta aunque la
// clienta lo había confirmado con el bot de Kapso: el equipo valida leyendo
// aquí, sin salir de la ficha. Misma anatomía que «Chatby» (la clienta a la
// izquierda, la tienda a la derecha, por día de Lima) y la misma regla de
// carga: se pide al abrir la ficha de este pedido, nunca en segundo plano para
// todos. Los adjuntos solo dicen su tipo; se abren en Kapso.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, OpsButton, SECTION_CARD, SectionHead, Skeleton, opsButtonClass } from "@/components/ops-ui";
import { IconArrowUpRight, IconRepeat } from "@/components/icons";
import { ConversationThread, ReplyBox } from "@/components/order-chatby-panel";
import { loadOrderKapso } from "@/app/dashboard/pedidos/actions";
import { KAPSO_THREAD_LIMIT, type OrderKapsoConversation } from "@/lib/order-kapso";
import { chatbyCustomerCount, type ChatbyMessage } from "@/lib/chatby-conversation";

type LoadState = { status: "cargando" } | { status: "listo"; result: OrderKapsoConversation };

/** Kapso no dice si escribió el bot o una persona: el lado de la tienda es «Tienda». */
function kapsoSpeaker(message: ChatbyMessage): string | null {
  if (message.kind === "cliente") return null;
  return message.template ? `Tienda · plantilla ${message.template}` : "Tienda";
}

const SOURCE_LABEL: Record<Extract<OrderKapsoConversation, { status: "ok" }>["source"], string> = {
  pedido: "La conversación donde se tomó este pedido.",
  lead: "La conversación del lead de este celular (el pedido no guardó la suya).",
  celular: "La conversación más reciente de este celular en Kapso (el pedido no guardó la suya).",
};

export function OrderKapsoPanel({
  orderId,
  orderName,
  onCustomerMessages,
  canEdit = false,
  shalomTicket = null,
}: {
  orderId: string;
  orderName: string | null;
  /** Cuántos de los mensajes traídos son de la clienta, para la cifra de la pestaña; null mientras no se sabe. */
  onCustomerMessages?: (count: number | null) => void;
  /** Quien puede editar el pedido también le responde a la clienta (`master.edit`). */
  canEdit?: boolean;
  /** La guía Shalom cuyo ticket se puede mandar en PDF (lib/chatby-attachments.ts). */
  shalomTicket?: { guideCode: string | null } | null;
}) {
  const [state, setState] = useState<LoadState | null>(null);
  const [sentNotice, setSentNotice] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);

  const load = useCallback(() => {
    loadedFor.current = orderId;
    setState({ status: "cargando" });
    loadOrderKapso(orderId)
      .then((result) => {
        if (loadedFor.current === orderId) setState({ status: "listo", result });
      })
      .catch(() => {
        if (loadedFor.current === orderId) setState({ status: "listo", result: { status: "error", message: "No hubo respuesta de Kapta." } });
      });
  }, [orderId]);

  useEffect(() => {
    if (loadedFor.current !== orderId) load();
  }, [orderId, load]);

  const result = state?.status === "listo" ? state.result : null;
  useEffect(() => {
    onCustomerMessages?.(result?.status === "ok" ? chatbyCustomerCount(result.messages) : null);
  }, [result, onCustomerMessages]);
  const loading = state?.status === "cargando";
  const inboxUrl = result?.status === "ok" ? result.inboxUrl : null;

  return (
    <section aria-labelledby="pedido-kapso-title" className={cn("space-y-4", SECTION_CARD)}>
      <SectionHead
        id="pedido-kapso-title"
        title="Conversación en Kapso"
        badge={canEdit ? undefined : <Badge>Solo lectura</Badge>}
        help={
          canEdit
            ? `Los últimos ${KAPSO_THREAD_LIMIT} mensajes de la clienta con el bot de Kapso de la tienda, en hora de Lima. Para validar lo que confirmó con el bot y para responderle aquí, dentro de las 24 h de WhatsApp.`
            : `Los últimos ${KAPSO_THREAD_LIMIT} mensajes de la clienta con el bot de Kapso de la tienda, en hora de Lima. Sirve para validar lo que la clienta confirmó con el bot; para escribirle, en Leads o en Kapso.`
        }
        aside={
          <>
            <OpsButton onClick={load} disabled={loading} className="pointer-coarse:h-11">
              <IconRepeat aria-hidden />
              {loading ? "Cargando…" : "Actualizar"}
            </OpsButton>
            {inboxUrl && (
              <a href={inboxUrl} target="_blank" rel="noreferrer noopener" className={opsButtonClass("secondary", "md", "pointer-coarse:h-11")}>
                <IconArrowUpRight aria-hidden />
                Abrir en Kapso
              </a>
            )}
          </>
        }
      />

      {sentNotice && (
        <Banner tone="ok" role="status">
          {sentNotice}
        </Banner>
      )}
      <div aria-live="polite" aria-busy={loading}>
        {loading || !state ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-3/4" />
            <Skeleton className="ml-auto h-16 w-2/3" />
            <Skeleton className="h-10 w-1/2" />
          </div>
        ) : result?.status === "ok" ? (
          result.messages.length ? (
            <div className="space-y-2">
              <p className="text-[13px] leading-5 text-ink-600">{SOURCE_LABEL[result.source]}</p>
              <ConversationThread messages={result.messages} orderName={orderName} speakerOf={kapsoSpeaker} />
              {canEdit && (
                <ReplyBox
                  channel="kapso"
                  orderId={orderId}
                  messages={result.messages}
                  inboxUrl={result.inboxUrl}
                  shalomTicket={shalomTicket}
                  onSent={(notice) => {
                    setSentNotice(notice);
                    load();
                  }}
                />
              )}
            </div>
          ) : (
            <p className="text-sm text-ink-600">La conversación de esta clienta en Kapso está vacía.</p>
          )
        ) : result?.status === "sin_conversacion" ? (
          <p className="text-sm text-ink-600">Esta clienta no tiene conversación en Kapso.</p>
        ) : result?.status === "sin_celular" ? (
          <p className="text-sm text-ink-600">El pedido no trae un celular que se pueda buscar en Kapso.</p>
        ) : result?.status === "sin_kapso" ? (
          <Banner tone="info" title="Kapso no está conectado en esta tienda">
            La tienda no tiene la clave de Kapso en sus Ajustes.
          </Banner>
        ) : result?.status === "error" ? (
          <Banner tone="crit" title="No se pudo cargar la conversación de Kapso" role="alert">
            {result.message} El resto de la ficha sigue igual.
          </Banner>
        ) : null}
      </div>
    </section>
  );
}
