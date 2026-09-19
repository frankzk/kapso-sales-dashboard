-- 0170_shalom_arrival_notice.sql — el segundo aviso: «tu pedido YA LLEGÓ a la
-- agencia».
--
-- EL HUECO. El aviso de la 0166 sale cuando la guía pasa a `en_transito` y dice
-- «llegará en 2 a 5 días hábiles». Eso solo es verdad mientras el paquete viaja.
-- A 18-09-2026 había **213 guías esperando en el mostrador con saldo** (173 de
-- Kenku y 40 de Aurela, unos S/ 34.000) a las que nunca se les escribió: o
-- llegaron antes de que esto existiera, o su tránsito ocurrió con el aviso
-- apagado. Mandarles la plantilla de tránsito sería decirles que esperen un
-- paquete que ya está esperándolas a ellas.
--
-- DOS AVISOS POR GUÍA, NO UNO. Hasta ahora `unique (shipment_id)` garantizaba
-- «una vez por guía». Eso deja de valer: una misma guía tiene que poder
-- recibir el de tránsito y, días después, el de llegada. La unique pasa a ser
-- `(shipment_id, kind)`, que sigue garantizando lo mismo POR TIPO de aviso —
-- que es la garantía que de verdad importaba: no repetirle a nadie el mismo
-- mensaje.
--
-- POR QUÉ `kind` NACE EN 'transito'. Las 75 filas que ya existen son todas de
-- tránsito. El default las deja correctas sin tocarlas y sin backfill.
--
-- PLANTILLA APARTE, INTERRUPTOR APARTE. El texto es otro y se aprueba aparte en
-- Meta; y encender uno no puede encender el otro. Lo que SÍ se comparte es el
-- número, el horario y las cuentas de cobro: son de la tienda, no del aviso.

alter table shalom_transit_notifications
  add column if not exists kind text not null default 'transito';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'shalom_transit_notifications_kind_check'
  ) then
    alter table shalom_transit_notifications
      add constraint shalom_transit_notifications_kind_check
      check (kind in ('transito', 'disponible'));
  end if;
end $$;

-- La unique vieja (una fila por guía) se sustituye por una por guía Y tipo.
alter table shalom_transit_notifications
  drop constraint if exists shalom_transit_notifications_shipment_id_key;
drop index if exists shalom_transit_notifications_shipment_id_key;

create unique index if not exists shalom_transit_notifications_shipment_kind_uniq
  on shalom_transit_notifications (shipment_id, kind);

comment on column shalom_transit_notifications.kind is
  'Qué aviso es: transito (va en camino) o disponible (ya llegó a la agencia). '
  'La unique es (shipment_id, kind): una guía recibe cada aviso una sola vez.';

alter table stores
  add column if not exists shalom_arrival_template_enabled boolean not null default false,
  add column if not exists shalom_arrival_template_name    text,
  add column if not exists shalom_arrival_params           text
    not null default 'nombre,guia,codigo,producto,agencia,total,adelanto,saldo',
  add column if not exists shalom_arrival_attach_ticket    boolean not null default false;

comment on column stores.shalom_arrival_template_enabled is
  'Aviso de «ya llegó a la agencia». Independiente del de tránsito: encender '
  'uno no enciende el otro.';
comment on column stores.shalom_arrival_params is
  'Orden de variables de la plantilla de llegada. Las mismas ocho del aviso de '
  'tránsito: el texto cambia, los datos no. El token `vence` (fecha límite de '
  'recojo) existe y NO se usa por omisión — se decidió urgir sin poner fecha, '
  'porque una fecha a 28 días invita a dejarlo para después.';
