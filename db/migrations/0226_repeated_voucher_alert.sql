-- 0226_repeated_voucher_alert.sql — alerta urgente cuando un mismo comprobante
-- aparece en más de un pedido.
--
-- EL CASO (29-09-2026). Un solo Lemon de S/ 89 (20-08, 15:12) era el comprobante
-- de cuatro pedidos Tanders —#KP124940, #KP126075, #KP126468, #KP126871—: el
-- mismo archivo, byte a byte, subido cuatro veces. Nadie se enteró en un mes.
-- El lector no pudo leer el nº de operación (sale cortado, «2026…843») y la
-- huella del archivo, que sí lo habría cazado, no avisaba a nadie: el duplicado
-- se bloqueaba en silencio.
--
-- Regla del owner: un mismo comprobante no puede estar en más de un pedido, y
-- cuando pase lo tienen que ver Frank, Yohalis, Akemi y Daysi. Por dos vías:
--
--   1. En Kapta: la alerta flotante con sonido (la misma de la cobranza, 0172),
--      para todos los que tengan el permiso `alerts.repeated_voucher` —se
--      concede persona por persona desde Equipo—, sin escalera: es urgente y la
--      ven todos a la vez. Queda abierta hasta que alguien diga qué hizo.
--   2. Por Telegram al grupo de alertas urgentes de la tienda
--      (`stores.urgent_telegram_chat_id`), porque quien no está conectado a
--      Kapta también tiene que enterarse.
--
-- `dedupe_key` evita que el barrido, que pasa cada hora, repita la misma alerta:
-- una por comprobante y tienda mientras esté abierta.

alter table collection_alerts drop constraint if exists collection_alerts_kind_check;
alter table collection_alerts add constraint collection_alerts_kind_check
  check (kind in ('registrado', 'sin_atribuir', 'comprobante_repetido'));

alter table collection_alerts add column if not exists dedupe_key text;

create unique index if not exists collection_alerts_dedupe_open_uniq
  on collection_alerts (store_id, dedupe_key)
  where dedupe_key is not null and status = 'abierta';

comment on column collection_alerts.dedupe_key is
  'Huella de lo que alerta (p. ej. el comprobante repetido). Una alerta abierta por huella y tienda.';

alter table stores add column if not exists urgent_telegram_chat_id text;

comment on column stores.urgent_telegram_chat_id is
  'Grupo/destinatarios de Telegram para alertas urgentes (comprobante repetido). '
  'Mismo formato que telegram_chat_id; usa el bot de la tienda.';
