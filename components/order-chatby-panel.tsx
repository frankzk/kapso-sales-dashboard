"use client";

// La pestaña «Chatby» de la ficha del pedido (MOM §25, 26-10-2026): la
// conversación de la clienta con el bot de confirmación de Chatby. Quien puede
// editar el pedido también le responde desde aquí (owner, 02-11-2026): texto,
// como persona del equipo y dentro de las 24 h de WhatsApp. Se pide al abrir la ficha del pedido (la cifra de la pestaña dice
// cuántos mensajes mandó la clienta), nunca en segundo plano para todos. El hilo tiene la misma anatomía que el
// chat de Leads (la clienta a la izquierda en blanco, la tienda a la derecha
// sobre `line`), con las notas internas aparte y los errores de WhatsApp en
// rojo. Las horas, siempre en Lima.

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { Badge, Banner, FIELD, OpsButton, SECTION_CARD, SectionHead, Skeleton, opsButtonClass } from "@/components/ops-ui";
import { IconAlert, IconArrowUpRight, IconChat, IconCheck, IconCopy, IconImage, IconMapPin, IconRepeat } from "@/components/icons";
import { copyLabel, useCopyToClipboard } from "@/components/copy-button";
import { createOrderChatbyUpload, loadOrderChatby, sendOrderChatbyReply } from "@/app/dashboard/pedidos/actions";
import { createBrowserSupabase } from "@/lib/supabase-browser";
import { fitWithin } from "@/lib/photo-resize";
import { CHATBY_ATTACHMENT_BUCKET, type ChatbyAttachmentRequest } from "@/lib/chatby-attachments";
import {
  CHATBY_MESSAGES_LIMIT,
  CHATBY_REPLY_MAX,
  CHATBY_REPLY_PAUSE_MINUTES,
  chatbyReplyWindow,
  chatbyDayLabel,
  chatbyLimaDay,
  chatbyLimaTime,
  chatbyCustomerCount,
  chatbyMentionsOrder,
  type ChatbyConversation,
  type ChatbyMessage,
} from "@/lib/chatby-conversation";
import {
  CHATBY_ASK_PURPOSE,
  chatbyAskExplanation,
  chatbyAskMessage,
  chatbyAskStatus,
  chatbyAskStatusAt,
  chatbyAskTitle,
  type ChatbyLocationHold,
} from "@/lib/chatby-location-ask";

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

function Bubble({
  message,
  current,
  speakerOf = speaker,
}: {
  message: ChatbyMessage;
  current: boolean;
  speakerOf?: (message: ChatbyMessage) => string | null;
}) {
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
  const who = speakerOf(message);
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

/**
 * El hilo de WhatsApp de la ficha: lo usan «Chatby» y «Kapso» (MOM §25), con
 * la misma anatomía. `speakerOf` dice quién habla encima de cada globo.
 */
export function ConversationThread({
  messages,
  orderName,
  speakerOf,
}: {
  messages: ChatbyMessage[];
  orderName: string | null;
  speakerOf?: (message: ChatbyMessage) => string | null;
}) {
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
            <Bubble message={message} current={chatbyMentionsOrder(message, orderName)} speakerOf={speakerOf} />
          </Fragment>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

type LoadResult = ChatbyConversation & { hold?: ChatbyLocationHold | null };
type LoadState = { status: "cargando" } | { status: "listo"; result: LoadResult };

const TEXTAREA = cn(FIELD, "h-auto py-2 leading-5");

/** Una foto (que se pueda pasar a JPG) o un PDF. */
function acceptedChatbyFile(f: File): boolean {
  return f.type === "application/pdf" || /\.pdf$/i.test(f.name) || ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(f.type);
}

/**
 * WhatsApp solo recibe fotos JPG o PNG de hasta 5 MB: un WEBP (así guarda
 * Chrome muchas capturas) o una foto pesada se pasa a JPG en el navegador.
 */
async function chatbyReadyFile(file: File): Promise<File> {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (isPdf) return file.type === "application/pdf" ? file : new File([file], file.name, { type: "application/pdf" });
  const okAsIs = (file.type === "image/jpeg" || file.type === "image/png") && file.size <= 4.5 * 1024 * 1024;
  if (okAsIs) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, 2000);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d", { alpha: false });
    if (!g) return file;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, width, height);
    g.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ? new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }) : file;
  } finally {
    bitmap.close();
  }
}

/** Sube el adjunto directo a Storage con la URL firmada del servidor. */
async function uploadChatbyAttachment(orderId: string, original: File): Promise<{ path: string } | { error: string }> {
  const file = await chatbyReadyFile(original);
  const prep = await createOrderChatbyUpload(orderId, file.type, file.size);
  if ("error" in prep) return { error: prep.error };
  const { error } = await createBrowserSupabase()
    .storage.from(CHATBY_ATTACHMENT_BUCKET)
    .uploadToSignedUrl(prep.path, prep.token, file, { contentType: file.type });
  if (error) return { error: `No se pudo subir el archivo: ${error.message}` };
  return { path: prep.path };
}

/** La URL local de la foto elegida, para enseñarla antes de mandarla. */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

/** «Hoy 18:20», «Ayer 09:12» o «03-11-2026 10:05», en Lima. */
function whenInLima(iso: string): string {
  const day = chatbyLimaDay(iso);
  return `${day ? chatbyDayLabel(day) : ""} ${chatbyLimaTime(iso)}`.trim();
}

/**
 * La caja para responder (MOM §25, «Chatby», 02-11-2026). Solo con la ventana
 * de 24 h de WhatsApp abierta; si está cerrada, dice por qué y manda a Chatby
 * (allí están las plantillas). El servidor vuelve a comprobar todo antes de
 * mandar.
 */
function ReplyBox({
  orderId,
  messages,
  inboxUrl,
  onSent,
  shalomTicket = null,
}: {
  orderId: string;
  messages: ChatbyMessage[];
  inboxUrl: string;
  /** Salió: el panel vuelve a leer la conversación y muestra el aviso. */
  onSent: (notice: string) => void;
  shalomTicket?: { guideCode: string | null } | null;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<null | "texto" | "ticket">(null);
  const [error, setError] = useState<string | null>(null);
  // El adjunto (owner 10-11-2026): una foto o un PDF, elegido, arrastrado o
  // pegado con Ctrl+V dentro de la caja (lib/chatby-attachments.ts).
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const preview = useObjectUrl(file && file.type.startsWith("image/") ? file : null);
  const ventana = chatbyReplyWindow(messages);

  if (!ventana.open) {
    return (
      <Banner tone="info" title="No se le puede escribir desde aquí">
        {ventana.lastCustomerAt
          ? `La clienta escribió por última vez: ${whenInLima(ventana.lastCustomerAt)}. Pasaron más de 24 horas y WhatsApp no deja mandarle texto libre.`
          : "La clienta no escribió en estos mensajes: WhatsApp solo deja mandarle texto libre hasta 24 horas después de su último mensaje."}{" "}
        Para escribirle hay que usar una plantilla desde{" "}
        <a href={inboxUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-brand-700 hover:underline">
          Chatby
        </a>
        .
      </Banner>
    );
  }

  const pick = (incoming: File | null | undefined) => {
    if (!incoming) return;
    if (!acceptedChatbyFile(incoming)) {
      setError("Solo se pueden mandar fotos o PDF.");
      return;
    }
    setError(null);
    setFile(incoming);
  };

  const send = async (mode: "texto" | "ticket") => {
    setPending(mode);
    setError(null);
    try {
      let attachment: ChatbyAttachmentRequest | null = null;
      if (mode === "ticket") {
        attachment = { kind: "shalom_ticket" };
      } else if (file) {
        const uploaded = await uploadChatbyAttachment(orderId, file);
        if ("error" in uploaded) {
          setError(uploaded.error);
          return;
        }
        attachment = { kind: "upload", path: uploaded.path, filename: file.name };
      }
      const result = await sendOrderChatbyReply(orderId, text, { attachment });
      if (result.error) {
        setError(result.error);
        return;
      }
      setText("");
      if (mode === "texto") setFile(null);
      onSent(result.notice ?? "Mensaje enviado.");
    } catch {
      setError("No hubo respuesta de Kapta. El mensaje puede no haber salido: revísalo con «Actualizar».");
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      className={cn("space-y-2 rounded-lg transition-colors", over && "bg-brand-50 ring-2 ring-brand-500 ring-offset-4")}
      onPaste={(e) => {
        const pasted = Array.from(e.clipboardData?.files ?? []).find(acceptedChatbyFile);
        if (!pasted) return;
        // Con texto e imagen en el portapapeles, en el cuadro de texto gana el texto.
        if (e.target instanceof HTMLTextAreaElement && e.clipboardData.getData("text/plain").trim()) return;
        e.preventDefault();
        pick(pasted);
      }}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const dropped = Array.from(e.dataTransfer.files).find(acceptedChatbyFile);
        if (!dropped) return;
        e.preventDefault();
        pick(dropped);
      }}
    >
      <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">
        Responder por WhatsApp
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={CHATBY_REPLY_MAX}
          placeholder={file ? "Mensaje que acompaña al archivo (opcional)…" : "Escribe tu mensaje para la clienta…"}
          className={TEXTAREA}
        />
      </label>
      {file ? (
        <div className="flex items-center gap-3 rounded-md bg-wash p-2 ring-1 ring-line">
          {preview ? (
            <img src={preview} alt="Foto adjunta" className="size-14 rounded object-cover ring-1 ring-line" />
          ) : (
            <span className="grid size-14 place-items-center rounded bg-white text-xs font-semibold text-ink-600 ring-1 ring-line">PDF</span>
          )}
          <p className="min-w-0 flex-1 truncate text-[13px] text-ink-700" title={file.name}>
            <span className="font-medium text-ink-900">{file.name}</span> · {Math.max(1, Math.round(file.size / 1024))} KB
          </p>
          <OpsButton size="sm" variant="ghost" disabled={pending !== null} onClick={() => setFile(null)} className="pointer-coarse:h-11">
            Quitar
          </OpsButton>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <OpsButton
          variant="primary"
          disabled={pending !== null || (!text.trim() && !file)}
          onClick={() => void send("texto")}
          className="pointer-coarse:h-11"
        >
          <IconChat aria-hidden />
          {pending === "texto" ? (file ? "Subiendo y enviando…" : "Enviando…") : "Enviar por WhatsApp"}
        </OpsButton>
        <OpsButton size="sm" disabled={pending !== null} onClick={() => fileRef.current?.click()} className="pointer-coarse:h-11">
          <IconImage aria-hidden className="text-ink-500" />
          {file ? "Cambiar archivo" : "Adjuntar foto o PDF"}
        </OpsButton>
        {shalomTicket && (
          <OpsButton
            size="sm"
            disabled={pending !== null}
            onClick={() => void send("ticket")}
            className="pointer-coarse:h-11"
            title="El ticket de la guía Shalom, el que la clienta muestra en la agencia para recoger. Si escribiste un mensaje, va como pie."
          >
            {pending === "ticket" ? "Enviando ticket…" : `Enviar ticket Shalom (PDF)${shalomTicket.guideCode ? ` · ${shalomTicket.guideCode}` : ""}`}
          </OpsButton>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf,.pdf,.webp"
          className="hidden"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs leading-4 text-ink-500">
          Sale como persona del equipo. El bot de esta clienta queda en pausa {CHATBY_REPLY_PAUSE_MINUTES} minutos. Se puede
          escribir hasta: {whenInLima(ventana.closesAt)}. Una captura se pega aquí con Ctrl+V.
        </p>
      </div>
      {error && (
        <Banner tone="crit" role="alert">
          {error}
        </Banner>
      )}
    </div>
  );
}

/**
 * Por qué se paró la guía automática y, con un clic, pedirle la ubicación a la
 * clienta (MOM §6.1, owner 08-11-2026). El mensaje viene escrito y se puede
 * editar; sale por el mismo envío que «Responder por WhatsApp» (las 24 h de
 * WhatsApp y la pausa del bot, que el servidor vuelve a comprobar).
 */
function LocationAskBanner({
  orderId,
  hold,
  messages,
  inboxUrl,
  canEdit,
  onSent,
}: {
  orderId: string;
  hold: ChatbyLocationHold;
  messages: ChatbyMessage[];
  inboxUrl: string;
  canEdit: boolean;
  onSent: (notice: string) => void;
}) {
  const [text, setText] = useState(() =>
    chatbyAskMessage({ ask: hold.ask, customerName: hold.customerName, orderName: hold.orderName }),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ventana = chatbyReplyWindow(messages);
  const statusAt = chatbyAskStatusAt(hold);

  const send = () => {
    setPending(true);
    setError(null);
    sendOrderChatbyReply(orderId, text, { purpose: CHATBY_ASK_PURPOSE })
      .then((result) => {
        if (result.error) {
          setError(result.error);
          return;
        }
        onSent(result.notice ?? "Mensaje enviado.");
      })
      .catch(() => setError("No hubo respuesta de Kapta. El mensaje puede no haber salido: revísalo con «Actualizar»."))
      .finally(() => setPending(false));
  };

  return (
    <Banner tone="warn" title={chatbyAskTitle(hold.reason, hold.google)} role="status">
      <div className="mt-1 space-y-3">
        <p className="leading-5">{chatbyAskExplanation(hold)}</p>
        {/* (0318) Si Kapta ya se la pidió sola, lo dice con la hora: la asesora no la vuelve a pedir. */}
        <p className="leading-5 text-ink-600">{chatbyAskStatus(hold, statusAt ? whenInLima(statusAt) : null)}</p>
        {canEdit &&
          (ventana.open ? (
            <div className="space-y-2">
              <label className="grid gap-1.5 text-[13px] font-medium text-ink-700">
                Mensaje para la clienta (puedes editarlo)
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={3}
                  maxLength={CHATBY_REPLY_MAX}
                  className={TEXTAREA}
                />
              </label>
              <OpsButton variant="primary" disabled={pending || !text.trim()} onClick={send} className="pointer-coarse:h-11">
                <IconMapPin aria-hidden />
                {pending ? "Enviando…" : "Pedir ubicación por WhatsApp"}
              </OpsButton>
            </div>
          ) : (
            <p className="leading-5">
              {ventana.lastCustomerAt
                ? `La clienta escribió por última vez: ${whenInLima(ventana.lastCustomerAt)}. Pasaron más de 24 horas y WhatsApp no deja mandarle texto libre.`
                : "La clienta no escribió en estos mensajes: WhatsApp solo deja mandarle texto libre hasta 24 horas después de su último mensaje."}{" "}
              Pídesela con una plantilla desde{" "}
              <a href={inboxUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-brand-700 hover:underline">
                Chatby
              </a>
              .
            </p>
          ))}
        {error && (
          <p role="alert" className="font-medium text-crit-fg">
            {error}
          </p>
        )}
      </div>
    </Banner>
  );
}

/**
 * El celular de la clienta en grande, con su botón de copiar (owner,
 * 26-10-2026): hay asesoras con miopía que lo copian para buscarlo en Chatby o
 * en WhatsApp, y en la cabecera de la ficha va en letra chica. Se ve agrupado
 * de a tres para leerlo sin perderse; se copia tal cual está guardado.
 */
export function ChatbyPhone({ phone }: { phone: string | null }) {
  const { state, copy } = useCopyToClipboard();
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  const shown = digits.length === 11 && digits.startsWith("51")
    ? `+51 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`
    : phone;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-wash px-4 py-3 ring-1 ring-line">
      <div className="min-w-0">
        <p className="text-[13px] font-medium leading-5 text-ink-600">Celular de la clienta</p>
        <p className="text-2xl font-semibold leading-8 tracking-wide text-ink-900 tabular-nums sm:text-3xl sm:leading-10">
          {shown}
        </p>
      </div>
      <OpsButton onClick={() => copy(phone)} className="ml-auto h-11 px-4 text-[15px]" aria-label="Copiar el celular de la clienta">
        {state === "ok" ? <IconCheck aria-hidden /> : <IconCopy aria-hidden />}
        <span aria-live="polite">{copyLabel(state, "Copiar celular")}</span>
      </OpsButton>
    </div>
  );
}

export function OrderChatbyPanel({
  orderId,
  orderName,
  phone = null,
  canEdit = false,
  onCustomerMessages,
  shalomTicket = null,
}: {
  orderId: string;
  orderName: string | null;
  /**
   * La guía Shalom creada por API (no anulada) cuyo ticket se puede mandar en
   * PDF desde «Responder por WhatsApp»; null si no hay (lib/chatby-attachments.ts).
   */
  shalomTicket?: { guideCode: string | null } | null;
  /** El celular de la clienta, en grande y con «Copiar celular» arriba de la conversación. */
  phone?: string | null;
  /** Quien puede editar el pedido también puede responderle a la clienta (`master.edit`). */
  canEdit?: boolean;
  /** Cuántos de los mensajes traídos son de la clienta, para la cifra de la pestaña; null mientras no se sabe. */
  onCustomerMessages?: (count: number | null) => void;
}) {
  const [state, setState] = useState<LoadState | null>(null);
  const [sentNotice, setSentNotice] = useState<string | null>(null);
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
    if (loadedFor.current !== orderId) {
      setSentNotice(null);
      load();
    }
  }, [orderId, load]);

  const onSent = useCallback(
    (notice: string) => {
      setSentNotice(notice);
      load();
    },
    [load],
  );

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
        badge={canEdit ? undefined : <Badge>Solo lectura</Badge>}
        help={`Los últimos ${CHATBY_MESSAGES_LIMIT} mensajes de la clienta con el bot de confirmación, en hora de Lima. Kenku y Aurela comparten el bot: pueden salir mensajes de las dos marcas.${canEdit ? " Lo que escribas abajo le llega por WhatsApp." : ""}`}
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

      <ChatbyPhone phone={phone} />

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
          <div className="space-y-3">
            {result.hold && (
              <LocationAskBanner
                key={`${orderId}:${result.hold.reason}:${result.hold.ask}`}
                orderId={orderId}
                hold={result.hold}
                messages={result.messages}
                inboxUrl={result.inboxUrl}
                canEdit={canEdit}
                onSent={onSent}
              />
            )}
            {result.messages.length ? (
              <div className="space-y-2">
                {result.name && <p className="text-[13px] leading-5 text-ink-600">En Chatby: {result.name}</p>}
                <ConversationThread messages={result.messages} orderName={orderName} />
              </div>
            ) : (
              <p className="text-sm text-ink-600">La conversación de esta clienta en Chatby está vacía.</p>
            )}
            {canEdit && (
              <ReplyBox
                orderId={orderId}
                messages={result.messages}
                inboxUrl={result.inboxUrl}
                onSent={onSent}
                shalomTicket={shalomTicket}
              />
            )}
          </div>
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
