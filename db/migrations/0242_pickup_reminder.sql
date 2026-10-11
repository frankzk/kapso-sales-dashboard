-- 0242_pickup_reminder.sql — el tercer aviso: el RECORDATORIO de recojo, al
-- día 3 y al día 7 de que la guía quedó disponible en la agencia (MOM §12).
--
-- EL HUECO. El aviso de llegada (0169/0170) sale UNA vez, el día que el paquete
-- llega, y después nada. Medido el 10-10-2026: Kenku tenía 230 pedidos en la
-- agencia (Shalom 224, Olva 6) que todavía debían el saldo, S/ 37.087 en
-- total — 82 llegados hace 3 días o menos, 28 de 4 a 7 días, 39 de 8 a 14, 36
-- de 15 a 21, 9 de 22 o más (Shalom devuelve a los 28) y 36 sin fecha de
-- llegada conocida. Un paquete que se queda en el mostrador sin cobrar acaba
-- volviendo a Lima con el flete pagado dos veces.
--
-- DOS TIPOS, NO UNO CON CONTADOR. La cola ya garantiza «cada aviso una sola
-- vez por guía» con la unique `(shipment_id, kind)` (0170). Para que el de día
-- 3 y el de día 7 salgan como mucho una vez cada uno basta con que sean dos
-- `kind`: `recordatorio_d3` y `recordatorio_d7`. Un único `recordatorio` con
-- un contador obligaría a cambiar la unique y a reescribir el «exactamente una
-- vez», que hoy no hay que tocar. Olva guarda el paquete solo 6 días: para
-- Olva únicamente existe el de día 3.
--
-- PLANTILLA PROPIA, CON IMAGEN. Se aprueba aparte en Meta (`guias_shalom_
-- recordatorio`, `guias_olva_recordatorio`) con cabecera de IMAGEN —la foto del
-- producto, la misma del espejo de catálogo que usan los carritos (0164,
-- 0233)— y cinco variables: nombre, agencia, guía, saldo y fecha límite. Si el
-- pedido no tiene foto se usa la imagen de respaldo de la tienda; sin ninguna
-- de las dos el recordatorio no sale (una plantilla con cabecera de imagen sin
-- imagen la rechaza Meta).
--
-- NACE APAGADO, por tienda y por courier. Comparte con los otros avisos el
-- número, el horario, las cuentas de cobro, los botones y el TOPE (0194).

-- ── 1. La cola admite los dos recordatorios ─────────────────────────────────
alter table shalom_transit_notifications
  drop constraint if exists shalom_transit_notifications_kind_check;
alter table shalom_transit_notifications
  add constraint shalom_transit_notifications_kind_check
  check (kind in ('transito', 'disponible', 'recordatorio_d3', 'recordatorio_d7'));

comment on column shalom_transit_notifications.kind is
  'Qué aviso es: transito (va en camino), disponible (ya llegó a la agencia), '
  'recordatorio_d3 / recordatorio_d7 (sigue en la agencia y debe el saldo, a '
  'los 3 y 7 días de llegar; Olva solo el de 3). La unique es (shipment_id, '
  'kind): una guía recibe cada aviso una sola vez.';

-- La foto que viajó en la cabecera, igual que `cart_seq_sends.image_url`
-- (0233): «¿qué imagen le mandamos?» no se puede contestar de otra forma
-- cuando el catálogo ya cambió.
alter table shalom_transit_notifications
  add column if not exists header_image_url text;

comment on column shalom_transit_notifications.header_image_url is
  'URL de la imagen mandada en la cabecera de la plantilla (recordatorio de '
  'recojo): la foto del producto vía /api/wa-image o la de respaldo de la tienda.';

-- ── 2. Config por tienda ────────────────────────────────────────────────────
alter table stores
  add column if not exists shalom_reminder_template_enabled boolean not null default false,
  add column if not exists shalom_reminder_template_name    text default 'guias_shalom_recordatorio',
  add column if not exists shalom_reminder_params           text not null
    default 'nombre,agencia,guia,saldo,vence',
  add column if not exists olva_reminder_template_enabled   boolean not null default false,
  add column if not exists olva_reminder_template_name      text default 'guias_olva_recordatorio',
  add column if not exists olva_reminder_params             text not null
    default 'nombre,agencia,guia,saldo,vence',
  -- Una para los dos couriers: es la imagen de la TIENDA (logo, una foto de
  -- marca) para el pedido cuyo producto no tiene foto en el catálogo. Tiene
  -- que ser JPG o PNG por https: Meta la baja al enviar.
  add column if not exists shalom_reminder_fallback_image_url text;

comment on column stores.shalom_reminder_template_enabled is
  'Recordatorio de recojo para guías de Shalom: día 3 y día 7 después de '
  'llegar a la agencia, solo si sigue allí y debe saldo. Nace apagado.';
comment on column stores.shalom_reminder_params is
  'Orden de variables del recordatorio. Por omisión: nombre, agencia, guia, '
  'saldo, vence (la fecha límite de recojo, 28 días desde la llegada).';
comment on column stores.olva_reminder_template_enabled is
  'Recordatorio de recojo para guías de Olva: solo el del día 3 (Olva '
  'devuelve a los 6 días). Independiente del de Shalom.';
comment on column stores.olva_reminder_params is
  'Orden de variables del recordatorio de Olva. `vence` se calcula a 6 días.';
comment on column stores.shalom_reminder_fallback_image_url is
  'Imagen de cabecera del recordatorio cuando el producto no tiene foto en el '
  'espejo de catálogo. JPG o PNG por https. Vacía y sin foto ⇒ no se manda.';
