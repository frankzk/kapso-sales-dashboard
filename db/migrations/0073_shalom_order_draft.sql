-- ============================================================================
-- 0073_shalom_order_draft.sql — adelantar el destinatario y la agencia de Shalom.
--
-- QUÉ PROBLEMA RESUELVE. Crear la guía de Shalom exige dos datos que el pedido
-- de Shopify NO trae: el DOCUMENTO del destinatario (Shopify no pide DNI) y la
-- AGENCIA de destino. Hoy los escribe quien crea la guía, en ese momento, y a
-- menudo es una persona distinta de la que habló con la clienta — que es
-- justamente quien tiene el DNI a mano, porque acaba de pedírselo para el Yape.
--
-- Así que se pueden dejar apuntados ANTES, al registrar el pago, de forma
-- OPCIONAL: no condicionan el pago —bloquear un cobro por falta de un DNI sería
-- peor que el problema que resuelve— pero si están, quien luego crea la guía ya
-- los encuentra puestos y solo tiene que cotizar y crear.
--
-- POR QUÉ UNA TABLA Y NO COLUMNAS EN `orders`. `orders` es el espejo de Shopify:
-- lo que hay ahí viene de Shopify y se sobrescribe con cada sincronización. Esto
-- es una nota operativa nuestra sobre un pedido, no un dato del pedido.
--
-- POR QUÉ NO EN `shipments`. Porque el envío todavía no existe: el sentido de
-- esta tabla es apuntar los datos antes de que haya guía.
-- ============================================================================

create table if not exists shalom_order_drafts (
  order_id                uuid primary key references orders(id) on delete cascade,
  store_id                uuid not null references stores(id) on delete cascade,

  -- Destinatario. El tipo por defecto es DNI porque es el 99% de los casos.
  document_type           text check (document_type in ('DNI', 'RUC', 'CE')),
  document                text,

  -- Agencia de destino. Se guarda también el nombre: el id no dice nada al
  -- leerlo, y sin el nombre habría que ir a la API solo para pintar la pantalla.
  destiny_terminal_id     bigint,
  destiny_terminal_name   text,

  updated_by              uuid references auth.users(id) on delete set null,
  updated_at              timestamptz not null default now()
);

comment on table shalom_order_drafts is
  'Datos de Shalom apuntados por adelantado (documento del destinatario, agencia de destino) para que quien cree la guía no tenga que buscarlos. Opcionales: no bloquean nada.';

-- No lleva índice por `store_id`: se lee siempre por `order_id`, que es la clave
-- primaria, y la tabla tiene como mucho una fila por pedido.

alter table shalom_order_drafts enable row level security;

-- Misma postura que `order_payments` (0049): se LEE si tienes acceso a la
-- tienda, y se ESCRIBE solo desde el servidor con el rol de servicio, después de
-- comprobar permisos. Aquí no hay secreto que proteger —el documento del
-- destinatario lo ve cualquiera que lea el pedido— pero escribir por el cliente
-- saltaría la comprobación de permisos, y no hay razón para abrir esa puerta.
-- La clave de recojo, que sí es secreta, vive aparte en `shalom_pickup_keys` y
-- sigue siendo ilegible incluso para un administrador (0049 + 0053).
drop policy if exists shalom_order_drafts_select on shalom_order_drafts;
create policy shalom_order_drafts_select on shalom_order_drafts
  for select to authenticated
  using (store_id in (select auth_store_ids()));

-- Se revoca también a `authenticated`, no solo a `anon`: Supabase concede ALL a
-- ese rol en cada tabla nueva del esquema public, así que sin este revoke la
-- tabla nacería con permiso de escritura para cualquier usuario logueado. RLS lo
-- taparía —no hay policy de insert— pero el privilegio sobra igual, y es el
-- mismo criterio de 0053.
revoke all on shalom_order_drafts from public, anon, authenticated;
grant select on shalom_order_drafts to authenticated;
grant all privileges on shalom_order_drafts to service_role;
