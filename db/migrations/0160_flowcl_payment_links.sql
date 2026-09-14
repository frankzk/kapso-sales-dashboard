-- 0160_flowcl_payment_links.sql — los links de cobro de Flow.cl (pasarela).
--
-- QUÉ ES. Cuando el asesor genera un link de pago desde el drawer, Flow crea
-- una orden y nos devuelve un token. Esta tabla guarda ese hecho: a qué pedido
-- pertenece, por cuánto, y qué pasó después. El webhook de Flow
-- (app/api/webhooks/flowcl) llega con el token y de aquí saca el pedido.
--
-- POR QUÉ UNA TABLA APARTE Y NO COLUMNAS EN `order_payments`. Porque un link
-- generado NO es dinero, y `order_payments` significa dinero. La diferencia
-- tiene consecuencia inmediata: `order_payments_kind_uniq` permite UN SOLO
-- adelanto vivo por pedido. Si el link se guardara ahí, generar un link que la
-- clienta no paga dejaría el sitio del adelanto ocupado para siempre — no
-- podría subir un comprobante de Yape ni el asesor generar otro link. El
-- pedido quedaría bloqueado por un cobro que nunca existió.
--
-- Separarlos también deja ver algo que hoy no se puede: cuántos links se
-- mandan y cuántos se pagan. Un link generado y nunca pagado es un hecho
-- operativo, no un vacío.
--
-- `commerce_order` ES LA LLAVE DE IDEMPOTENCIA. Es el identificador que
-- viaja a Flow y el que Flow nos devuelve. Único: dos filas con el mismo
-- commerce_order significarían dos links cobrables por el mismo concepto, que
-- es un cliente pagando dos veces.

create table if not exists flowcl_payment_links (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references stores(id) on delete cascade,
  order_id          uuid not null references orders(id) on delete cascade,

  -- Lo que se le mandó a Flow como `commerceOrder`.
  commerce_order    text not null unique,
  -- Qué comprobante sería este cobro si se paga. Mismos valores que
  -- order_payments.kind: el MOM ya define cuál cabe en cada momento.
  kind              text not null check (kind in ('adelanto', 'diferencia', 'total')),
  amount            numeric(12, 2) not null,
  currency          text not null default 'PEN',
  -- Identificador del medio de pago en Flow (170 = Yape One Shot).
  payment_method    integer,

  -- Lo que devolvió Flow al crear la orden.
  flow_token        text,
  flow_order        bigint,
  link              text,
  expires_at        timestamptz,

  -- Nuestro estado, no el de Flow. `creado` es un link vivo sin pagar.
  status            text not null default 'creado'
                      check (status in ('creado', 'pagado', 'rechazado', 'anulado', 'expirado')),
  -- El `status` numérico que dijo Flow la última vez (1..4). Se guarda crudo
  -- para poder auditar por qué decidimos lo que decidimos.
  flow_status       integer,
  paid_at           timestamptz,

  -- El comprobante que este cobro creó, si llegó a crearlo. Nulo mientras no
  -- esté pagado, y nulo también si el pago entró pero el comprobante no se
  -- pudo registrar: en ese caso el dinero consta AQUÍ y hay que mirarlo.
  payment_id        uuid references order_payments(id) on delete set null,
  -- Por qué no se pudo registrar el comprobante, si pasó.
  register_error    text,

  -- La última respuesta de payment/getStatus, entera. Es la prueba de qué dijo
  -- Flow: el medio real, la comisión, el saldo a depositar.
  last_status       jsonb not null default '{}'::jsonb,

  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- El webhook llega con el token y con nada más: es su única vía de entrada.
create unique index if not exists flowcl_links_token_uniq
  on flowcl_payment_links (flow_token)
  where flow_token is not null;

create index if not exists flowcl_links_order_idx on flowcl_payment_links (order_id);
-- Para el panel: links vivos de una tienda, y los pagados sin comprobante.
create index if not exists flowcl_links_store_status_idx
  on flowcl_payment_links (store_id, status);

alter table flowcl_payment_links enable row level security;

drop policy if exists flowcl_payment_links_select on flowcl_payment_links;
create policy flowcl_payment_links_select on flowcl_payment_links for select to authenticated
  using (store_id in (select auth_store_ids()));

-- Escribe el servidor (el botón del drawer y el webhook), con service-role.
-- No hay policy de insert/update para `authenticated` a propósito: un link de
-- cobro no se crea desde el browser.

comment on table flowcl_payment_links is
  'Links de cobro generados contra Flow.cl. Un link NO es dinero: el dinero '
  'aparece en order_payments solo cuando Flow confirma el pago.';
comment on column flowcl_payment_links.commerce_order is
  'El commerceOrder enviado a Flow. Llave de idempotencia: único en la tabla.';
comment on column flowcl_payment_links.payment_id is
  'El order_payments que creó este cobro. Nulo y con register_error relleno = '
  'el dinero entró pero el comprobante no se pudo registrar; requiere revisión.';
