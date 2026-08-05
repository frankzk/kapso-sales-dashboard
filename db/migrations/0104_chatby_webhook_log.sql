-- 0104 — Bitácora cruda del "Live Chat Webhook" de Chatby.
--
-- POR QUÉ UNA BITÁCORA Y NO LA TABLA DEFINITIVA
--
-- La API de Chatby (white-label de uChat) NO expone lectura de mensajes: sus
-- endpoints de conversación devuelven agregados (`in_messages`, `agent_messages`,
-- tiempos) y el modelo `Subscriber` solo trae `last_message_at` y
-- `last_message_type` — nunca el cuerpo. La única fuente del texto es este
-- webhook, que empuja los mensajes ENTRANTES cuando el bot está pausado.
--
-- Como no hay forma de pedir el histórico, TODO lo que no se guarde mientras el
-- webhook está apagado se pierde para siempre. Por eso esta tabla existe antes
-- que el diseño definitivo: primero se deja de perder historia, después se
-- modela con payloads reales en la mano en vez de suposiciones.
--
-- Es APPEND-ONLY y SIN PÉRDIDA a propósito: guarda el JSON completo tal como
-- llegó. Cuando exista `chatby_messages`, se rellena DESDE ACÁ — nada de lo
-- capturado en el período de aprendizaje se tira.
--
-- MEDIDO EN PRODUCCIÓN (2026-08-05): ESTE WEBHOOK NO CUBRE WHATSAPP.
--
-- La prueba: con el bot pausado se mandaron dos mensajes ENTRANTES de WhatsApp.
-- Cero entregas — y en los logs de Vercel no hay NINGUNA petición a esta ruta en
-- ese minuto. No es un 401 ni un error de configuración: Chatby no lo intentó.
-- La configuración estaba bien, porque el ping de validación del Save sí llegó y
-- sí escribió fila con esa misma URL y esa misma cabecera.
--
-- O sea que "Live Chat" en Chatby significa su WIDGET WEB, no WhatsApp. Encaja
-- con el resto de esa zona de ajustes (el Secret Key y `window.$chatbot.setUser`
-- son del widget del navegador).
--
-- LA TABLA Y EL RECEPTOR SE CONSERVAN, y no por optimismo: el paso "External
-- Request" del flow builder — que sí corre sobre las conversaciones de WhatsApp —
-- puede POSTear a esta misma ruta con la misma cabecera. El receptor no está
-- atado a la integración que lo motivó.
--
-- OJO CON EL ALCANCE (limitaciones del propio webhook, no nuestras):
--   · Solo dispara con el bot PAUSADO. La fase en que el bot conversa no llega.
--   · Solo mensajes ENTRANTES. Los salientes los emitimos nosotros vía
--     `POST /subscriber/send-content`, y quedan en nuestra outbox.
--   · Se configura POR CUENTA, no por bot: un solo webhook para Aurela y Kenku.
--     Por eso NO hay `store_id` todavía — resolver la tienda exige saber qué trae
--     el payload (¿id de bot?, ¿número de WhatsApp de destino?), que es
--     justamente lo que esta bitácora viene a averiguar. Escribirlo a ciegas
--     sería peor que dejarlo nulo: mandaría mensajes a la tienda equivocada.

create table if not exists chatby_webhook_log (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  -- Extracción best-effort: `user_ns` es la clave del subscriber en la API de
  -- Chatby (aparece en el modelo Subscriber y la piden todos sus endpoints), así
  -- que buscarla no es adivinar, es su propio vocabulario. Nula si no viene: el
  -- objetivo es no perder la entrega, nunca rechazarla.
  user_ns text,
  -- Nombres de las cabeceras recibidas, SIN valores. Sirve para descubrir si
  -- Chatby manda alguna firma o id de idempotencia que convenga verificar más
  -- adelante. Los valores no se guardan nunca: uno de ellos es nuestro secreto.
  header_names text[] not null default '{}',
  -- ¿El cuerpo era JSON válido? Si no, `payload` lo conserva como {"_raw": "..."}
  -- en vez de descartarlo.
  parsed boolean not null default true,
  payload jsonb not null
);

-- El uso es "las últimas N entregas" mientras se diseña, y más adelante "todo lo
-- de este subscriber" para el backfill.
create index if not exists chatby_webhook_log_recent
  on chatby_webhook_log (received_at desc);
create index if not exists chatby_webhook_log_user_ns
  on chatby_webhook_log (user_ns, received_at desc)
  where user_ns is not null;

revoke all on table chatby_webhook_log from public, anon, authenticated;
grant all on table chatby_webhook_log to service_role;

alter table chatby_webhook_log enable row level security;

-- SIN POLÍTICAS A PROPÓSITO: RLS activo y cero policies = nadie lee salvo
-- service_role, que salta RLS. Acá hay texto de conversaciones de clientes y
-- todavía no se puede acotar por organización (no sabemos de qué tienda es cada
-- fila). Hasta que exista esa columna, cerrado del todo es la única postura
-- defendible; abrirlo por `authenticated` expondría los mensajes de una tienda a
-- los usuarios de la otra.
