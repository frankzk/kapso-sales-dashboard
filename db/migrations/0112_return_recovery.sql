-- ============================================================================
-- 0112_return_recovery.sql — recuperación del pedido devuelto.
--
-- QUÉ RESUELVE. Una guía de provincia sale contraentrega, la clienta no la
-- recibe y el paquete vuelve al almacén. Hoy ahí termina todo: `returned_at` se
-- sella, el pedido pasa a `devuelto` (§10) y nadie vuelve a escribirle. La
-- devolución es entrada elegible a Reproprovincia (§11), pero esa puerta solo se
-- abre si alguien contacta a la clienta — y contactarla una por una no escala.
--
-- Esta migración le da columnas al contacto: a quién ya se le escribió, cuándo,
-- y a quién se decidió no escribirle. El envío en sí es una plantilla aprobada
-- por Meta (`recuperacion_pedido_retornado`), que es la única forma de abrir
-- conversación fuera de la ventana de 24 h — y una devolución siempre está muy
-- fuera de esa ventana.
--
-- POR QUÉ VIVE EN `shipments` Y NO EN UNA TABLA APARTE. El estado de
-- recuperación es un atributo de la GUÍA devuelta, no una entidad nueva: hay
-- exactamente uno por guía y muere con ella. La tabla aparte
-- (`return_recovery_sends`) guarda los INTENTOS, que sí son varios y sí son
-- historial — el mismo reparto que ya usan el drip (0035) y la secuencia de
-- carritos (0040).
--
-- EL ADELANTO NO SE MODELA ACÁ. La plantilla propone reenviar por agencia con
-- adelanto; cuando la clienta acepta, lo que sigue —cobrar el adelanto, crear la
-- salida Shalom, liberar la clave— ya existe entero (§12) y no necesita columnas
-- nuevas. Esto termina donde empieza aquello: en la respuesta de la clienta.
-- ============================================================================

-- ── Configuración por tienda ────────────────────────────────────────────────
-- Espejo de las otras automatizaciones: interruptor propio, plantilla propia y
-- horario propio. Nace APAGADA en las dos tiendas — Aurela todavía no tiene la
-- plantilla aprobada, y encenderla sin plantilla solo produciría rechazos 132xxx.
alter table stores
  add column if not exists return_recovery_enabled  boolean not null default false,
  -- Segundo interruptor, independiente del primero: `enabled` habilita la cola y
  -- el botón; `auto` deja que el cron envíe sin que nadie mire. Están separados
  -- para poder mirar la cola unos días antes de soltarla — el mensaje pide plata
  -- por adelantado, así que el primer lote conviene verlo con ojos.
  add column if not exists return_recovery_auto     boolean not null default false,
  add column if not exists return_recovery_template_name     text,
  add column if not exists return_recovery_template_language text not null default 'es',
  -- Qué va en {{1}}, {{2}}, {{3}}… Es una lista ordenada de TOKENS, no el texto:
  -- el cuerpo de la plantilla lo aprueba Meta y puede diferir entre tiendas
  -- (Kenku y Aurela son WABAs distintas), así que el orden se configura en vez
  -- de compilarse. Tokens válidos en lib/return-recovery.ts.
  add column if not exists return_recovery_params   text not null default 'nombre,producto,monto',
  add column if not exists return_recovery_hour_start integer not null default 8,
  add column if not exists return_recovery_hour_end   integer not null default 21,
  -- Ventana de frescura: a una devolución de hace tres meses no se le escribe.
  -- El paquete ya se reingresó o se dio de baja, y la clienta no recuerda el
  -- pedido — el mensaje llega como spam de un desconocido.
  add column if not exists return_recovery_max_days   integer not null default 30;

comment on column stores.return_recovery_params is
  'Orden de los parámetros del cuerpo de la plantilla, por token: nombre, producto, monto, pedido, distrito, agencia. Debe coincidir con la plantilla aprobada en Meta.';
comment on column stores.return_recovery_auto is
  'Deja que el cron envíe sin intervención. Requiere return_recovery_enabled.';

-- ── Estado de recuperación de la guía ───────────────────────────────────────
alter table shipments
  -- null = sin tocar (candidata o no elegible, lo decide el código)
  -- 'enviado'    = la plantilla salió
  -- 'descartado' = alguien decidió que a esta clienta no se le escribe
  add column if not exists recovery_state        text,
  add column if not exists recovery_sent_at      timestamptz,
  add column if not exists recovery_dismissed_at timestamptz,
  add column if not exists recovery_dismissed_by uuid references auth.users(id) on delete set null,
  add column if not exists recovery_dismiss_reason text;

comment on column shipments.recovery_state is
  'Recuperación del pedido devuelto: null | enviado | descartado. Catálogo en lib/return-recovery.ts.';

-- La cola pregunta siempre por lo mismo: guías devueltas de esta tienda que
-- todavía no se tocaron. Índice parcial para no escanear las miles de guías que
-- nunca volvieron — que son la enorme mayoría.
create index if not exists shipments_recovery_queue_idx
  on shipments(store_id, returned_at desc)
  where returned_at is not null and recovery_state is null;

-- ── Historial de intentos ───────────────────────────────────────────────────
-- Por qué existe además de `recovery_sent_at`: la columna dice el desenlace, la
-- tabla dice qué pasó. Un envío rechazado por Meta (plantilla en revisión, tope
-- de mensajería, número inválido) no deja marca en la guía —para que vuelva a
-- salir en la cola— pero sí tiene que quedar registrado, o el mismo error se
-- repite sin que nadie sepa por qué la cola no baja.
create table if not exists return_recovery_sends (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references stores(id) on delete cascade,
  shipment_id   uuid not null references shipments(id) on delete cascade,
  phone         text not null,               -- normalizePhone() aplicado
  template_name text,
  ok            boolean not null default true,
  error         text,                        -- motivo cuando ok = false
  -- Quién lo mandó: null = el cron (modo automático); si no, la persona que
  -- pulsó el botón. Es la diferencia entre "el sistema decidió" y "alguien
  -- decidió", y con plata de por medio esa diferencia se audita.
  sent_by       uuid references auth.users(id) on delete set null,
  sent_at       timestamptz not null default now()
);
create index if not exists return_recovery_sends_store_sent_idx
  on return_recovery_sends(store_id, sent_at desc);
create index if not exists return_recovery_sends_shipment_idx
  on return_recovery_sends(shipment_id);

alter table return_recovery_sends enable row level security;
drop policy if exists return_recovery_sends_select on return_recovery_sends;
create policy return_recovery_sends_select on return_recovery_sends for select to authenticated
  using (store_id in (select auth_store_ids()));
grant select on return_recovery_sends to authenticated;
grant all privileges on return_recovery_sends to service_role;
