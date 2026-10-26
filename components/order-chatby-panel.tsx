"use client";

// La pestaña «Chatby» de la ficha del pedido (MOM §25, 26-10-2026): la
// conversación de la clienta con el bot de confirmación de Chatby, solo para
// leer. Se pide al abrir la ficha del pedido (la cifra de la pestaña dice
// cuántos mensajes mandó la clienta), nunca en segundo plano para todos. El hilo tiene la misma anatomía que el
// chat de Leads (la clienta a la izquierda en blanco, la tienda a la derecha
// sobre `line`), con las notas internas aparte y los errores de WhatsApp en
// rojo. Las horas, siempre en Lima.

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, OpsButton, SECTION_CARD, SectionHead, Skeleton, opsButtonClass } from "@/components/ops-ui";
import { IconAlert, IconArrowUpRight, IconImage, IconRepeat } from "@/components/icons";
import { loadOrderChatby } from "@/app/dashboard/pedidos/actions";
import {
  CHATBY_MESSAGES_LIMIT,
  chatbyDayLabel,
  chatbyLimaDay,
  chatbyLimaTime,
  chatbyCustomerCount,
  chatbyMentionsOrder,
  type ChatbyConversation,
  type ChatbyMessage,
} from "@/lib/chatby-conversation";

const MEDIA_LABEL: Record<NonNullable<ChatbyMessage["media"]>, string> = {
  imagen: "Imagen",
  audio: "Audio",
  video: "Video",
  archivo: "Archivo",
};

/** Quién habla, encima del globo de la tienda y de la nota. */
function speaker(message: ChatbyMessage): string | null {
  if (message.kind === "bot") return message.template ? `Bot · plantilla ${message.template}` : "Bot";
  if (message.kind === "equipo") return message.agent ? `Equipo · ${message.agent}` : "Equipo";
  return null;
}

function Bubble({ message, current }: { message: ChatbyMessage; current: boolean }) {
  const time = chatbyLimaTime(message.at);
  const stamp = time ? (
    <span className="ml-2 inline-flex translate-y-0.5 whitespace-nowrap align-baseline text-xs leading-none tabular-nums text-ink-500">
      {time}
    </span>
  ) : null;
  const thisOrder = current ? (
    <Badge tone="info" title="El mensaje nombra este pedido">
      Este pedido
    </Badge>
  ) : null;

  if (message.kind === "nota") {
    return (
      <div className="rounded-lg bg-warn-wash px-3 py-2 text-[13px] leading-5 text-ink-900 ring-1 ring-inset ring-warn-bg">
        <p className="mb-0.5 flex flex-wrap items-center gap-2 text-xs font-semibold text-warn-fg">
          Nota interna · la clienta no la vio {thisOrder}
        </p>
        <p className="whitespace-pre-wrap break-words">
          {message.text}
          {stamp}
        </p>
      </div>
    );
  }

  const fromCustomer = message.kind === "cliente";
  const who = speaker(message);
  return (
    <div className={cn("flex", fromCustomer ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-5 text-ink-900",
          message.error ? "bg-crit-wash ring-1 ring-inset ring-crit-bg" : fromCustomer ? "bg-white shadow-control ring-1 ring-line" : "bg-line",
        )}
      >
        {(who || thisOrder) && (
          <p className="mb-0.5 flex flex-wrap items-center gap-2 text-xs font-medium text-ink-500">
            {who}
            {thisOrder}
          </p>
        )}
        {message.error && (
          <p className="mb-0.5 flex items-center gap-1.5 text-xs font-semibold text-crit-fg">
            <IconAlert aria-hidden className="size-3.5" />
            WhatsApp no lo entregó
          </p>
        )}
        {message.media && (
          message.mediaUrl ? (
            <a
              href={message.mediaUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mb-0.5 flex items-center gap-1.5 font-medium text-brand-700 hover:underline"
            >
              <IconImage aria-hidden className="size-4 shrink-0" />
              {MEDIA_LABEL[message.media]}
            </a>
          ) : (
            <p className="mb-0.5 flex items-center gap-1.5 font-medium text-ink-600">
              <IconImage aria-hidden className="size-4 shrink-0" />
              {MEDIA_LABEL[message.media]}
            </p>
          )
        )}
        {message.button ? (
          <p className="break-words">
            <span className="text-ink-500">Tocó el botón </span>
            <span className="font-semibold">«{message.text}»</span>
            {stamp}
          </p>
        ) : message.text ? (
          <p className={cn("whitespace-pre-wrap break-words", message.error && "text-crit-fg")}>
            {message.text}
            {stamp}
          </p>
        ) : (
          <p className="text-right">{stamp}</p>
        )}
      </div>
    </div>
  );
}

function Thread({ messages, orderName }: { messages: ChatbyMessage[]; orderName: string | null }) {
  const endRef = useRef<HTMLDivElement>(null);
  // Lo último está abajo, como en WhatsApp: el hilo abre ahí.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);
  let lastDay: string | null = null;
  return (
    <div className="max-h-[60vh] space-y-2 overflow-y-auto rounded-lg bg-wash p-3 sm:p-4" role="log" aria-label="Mensajes de WhatsApp">
      {messages.map((message) => {
        const day = chatbyLimaDay(message.at);
        const showDay = day !== null && day !== lastDay;
        if (day) lastDay = day;
        return (
          <Fragment key={message.id}>
            {showDay && (
              <p className="pt-1 text-center">
                <span className="rounded-md bg-white px-2 py-0.5 text-xs font-medium text-ink-600 shadow-control ring-1 ring-line">
                  {chatbyDayLabel(day)}
                </span>
              </p>
            )}
            <Bubble message={message} current={chatbyMentionsOrder(message, orderName)} />
          </Fragment>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

type LoadState = { status: "cargando" } | { status: "listo"; result: ChatbyConversation };

export function OrderChatbyPanel({
  orderId,
  orderName,
  onCustomerMessages,
}: {
  orderId: string;
  orderName: string | null;
  /** Cuántos de los mensajes traídos son de la clienta, para la cifra de la pestaña; null mientras no se sabe. */
  onCustomerMessages?: (count: number | null) => void;
}) {
  const [state, setState] = useState<LoadState | null>(null);
  const loadedFor = useRef<string | null>(null);

  const load = useCallback(() => {
    loadedFor.current = orderId;
    setState({ status: "cargando" });
    loadOrderChatby(orderId)
      .then((result) => {
        if (loadedFor.current === orderId) setState({ status: "listo", result });
      })
      .catch(() => {
        if (loadedFor.current === orderId) {
          setState({ status: "listo", result: { status: "error", message: "No hubo respuesta de Kapta.", inboxUrl: null } });
        }
      });
  }, [orderId]);

  // Se pide al abrir la ficha de este pedido (no en segundo plano para todos):
  // la pestaña dice en su cifra si la clienta respondió sin tener que abrirla.
  useEffect(() => {
    if (loadedFor.current !== orderId) load();
  }, [orderId, load]);

  const result = state?.status === "listo" ? state.result : null;
  useEffect(() => {
    onCustomerMessages?.(result?.status === "ok" ? chatbyCustomerCount(result.messages) : null);
  }, [result, onCustomerMessages]);
  const inboxUrl = result?.status === "ok" ? result.inboxUrl : result?.status === "error" ? result.inboxUrl : null;
  const loading = state?.status === "cargando";

  return (
    <section aria-labelledby="pedido-chatby-title" className={cn("space-y-4", SECTION_CARD)}>
      <SectionHead
        id="pedido-chatby-title"
        title="Conversación en Chatby"
        badge={<Badge>Solo lectura</Badge>}
        help={`Los últimos ${CHATBY_MESSAGES_LIMIT} mensajes de la clienta con el bot de confirmación, en hora de Lima. Kenku y Aurela comparten el bot: pueden salir mensajes de las dos marcas.`}
        aside={
          <>
            <OpsButton onClick={load} disabled={loading} className="pointer-coarse:h-11">
              <IconRepeat aria-hidden />
              {loading ? "Cargando…" : "Actualizar"}
            </OpsButton>
            {inboxUrl && (
              <a href={inboxUrl} target="_blank" rel="noreferrer noopener" className={opsButtonClass("secondary", "md", "pointer-coarse:h-11")}>
                <IconArrowUpRight aria-hidden />
                Abrir en Chatby
              </a>
            )}
          </>
        }
      />

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
              {result.name && <p className="text-[13px] leading-5 text-ink-600">En Chatby: {result.name}</p>}
              <Thread messages={result.messages} orderName={orderName} />
            </div>
          ) : (
            <p className="text-sm text-ink-600">La conversación de esta clienta en Chatby está vacía.</p>
          )
        ) : result?.status === "sin_conversacion" ? (
          <p className="text-sm text-ink-600">Esta clienta no tiene conversación en Chatby.</p>
        ) : result?.status === "sin_celular" ? (
          <p className="text-sm text-ink-600">El pedido no trae un celular que se pueda buscar en Chatby.</p>
        ) : result?.status === "sin_clave" ? (
          <Banner tone="info" title="Chatby todavía no está conectado">
            Falta la clave «KAPTA» de Chatby en Kapta (<code className="text-xs">CHATBY_API_KEY</code>). Mientras
            tanto, la conversación se ve en Chatby.
          </Banner>
        ) : result?.status === "error" ? (
          <Banner tone="crit" title="No se pudo cargar la conversación de Chatby" role="alert">
            {result.message} El resto de la ficha sigue igual; prueba con «Actualizar».
          </Banner>
        ) : null}
      </div>
    </section>
  );
}
