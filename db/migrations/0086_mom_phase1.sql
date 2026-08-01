-- ============================================================================
-- 0086_mom_phase1.sql — Fundaciones del Master Operations Map.
--
-- Modo sombra: general_status/operational_status siguen siendo las pestañas
-- productivas. Las macroetapas nuevas se calculan en paralelo para validarlas
-- antes de promoverlas a navegación principal.
--
-- También formaliza que UNA guía es UNA salida física. Cada salida recibe un
-- consecutivo dentro del pedido y un QR opaco estable. El courier y la fecha son
-- metadatos: cambiar de courier nunca cambia el token de una salida existente.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Identidad y custodia de cada salida
-- ----------------------------------------------------------------------------

alter table shipments
  add column if not exists output_number integer,
  add column if not exists output_code text,
  add column if not exists qr_token uuid not null default gen_random_uuid(),
  -- no_iniciado | rotulo_generado | en_armado | listo_despacho | incidencia
  add column if not exists preparation_state text not null default 'no_iniciado',
  -- empresa | courier | retorno | devuelto
  add column if not exists custody_state text not null default 'empresa',
  add column if not exists ready_at timestamptz,
  add column if not exists ready_by uuid references auth.users(id) on delete set null,
  add column if not exists custody_transferred_at timestamptz,
  add column if not exists custody_transferred_by uuid references auth.users(id) on delete set null;

comment on column shipments.output_number is
  'Consecutivo inmutable de la salida física dentro del pedido: 1, 2, 3…';
comment on column shipments.output_code is
  'Identidad humana estable de salida, p. ej. KP123-S02. El courier se muestra aparte.';
comment on column shipments.qr_token is
  'Token opaco y estable del QR. No incluye pedido, courier, fecha ni datos del cliente.';
comment on column shipments.preparation_state is
  'Estado de preparación MOM: no_iniciado, rotulo_generado, en_armado, listo_despacho, incidencia.';
comment on column shipments.custody_state is
  'Custodia física MOM: empresa, courier, retorno o devuelto.';

-- Backfill determinista por pedido. En una base ya parcialmente migrada, los
-- nulos continúan después del máximo existente para no reutilizar consecutivos.
with existing as (
  select order_id, coalesce(max(output_number), 0) as max_number
    from shipments
   where order_id is not null and output_number is not null
   group by order_id
), pending as (
  select s.id,
         coalesce(e.max_number, 0) + row_number() over (
           partition by s.order_id
           order by coalesce(s.assigned_at, s.created_at), s.created_at, s.id
         ) as next_number
    from shipments s
    left join existing e on e.order_id = s.order_id
   where s.order_id is not null and s.output_number is null
)
update shipments s
   set output_number = p.next_number
  from pending p
 where s.id = p.id;

update shipments s
   set output_code = concat(
         regexp_replace(
           upper(trim(leading '#' from coalesce(nullif(s.order_name, ''), o.name, ''))),
           '[^A-Z0-9_-]+',
           '',
           'g'
         ),
         '-S',
         lpad(s.output_number::text, 2, '0')
       )
  from orders o
 where o.id = s.order_id
   and s.output_number is not null
   and s.output_code is null
   and coalesce(nullif(s.order_name, ''), o.name) is not null;

-- Una guía ya despachada estaba necesariamente armada y fuera de la oficina.
-- Para guías nuevas, la mera existencia de la guía prueba que el rótulo existe.
update shipments
   set preparation_state = case
         when dispatched_at is not null
           or out_for_delivery_at is not null
           or delivery_status in ('en_ruta', 'entregado', 'transferido')
           then 'listo_despacho'
         else 'rotulo_generado'
       end,
       ready_at = case
         when dispatched_at is not null
           or out_for_delivery_at is not null
           or delivery_status in ('en_ruta', 'entregado', 'transferido')
           then coalesce(dispatched_at, out_for_delivery_at, assigned_at, created_at)
         else ready_at
       end
 where preparation_state = 'no_iniciado';

update shipments
   set custody_state = case
         when returned_at is not null then 'devuelto'
         when dispatched_at is not null
           or out_for_delivery_at is not null
           or delivery_status in ('en_ruta', 'entregado', 'transferido')
           then 'courier'
         else custody_state
       end,
       custody_transferred_at = case
         when returned_at is null and (
           dispatched_at is not null
           or out_for_delivery_at is not null
           or delivery_status in ('en_ruta', 'entregado', 'transferido')
         ) then coalesce(dispatched_at, out_for_delivery_at, assigned_at, created_at)
         else custody_transferred_at
       end;

create unique index if not exists shipments_order_output_number_uniq
  on shipments(order_id, output_number)
  where order_id is not null and output_number is not null;
create unique index if not exists shipments_store_output_code_uniq
  on shipments(store_id, output_code)
  where output_code is not null;
create unique index if not exists shipments_qr_token_uniq on shipments(qr_token);
create index if not exists shipments_preparation_idx
  on shipments(store_id, preparation_state, created_at);
create index if not exists shipments_custody_idx
  on shipments(store_id, custody_state, created_at);

-- Asigna la identidad a toda nueva guía y también cuando una guía sin pedido se
-- vincula. Una corrección de vínculo conserva el qr_token, pero recalcula el
-- código humano/consecutivo para el pedido correcto.
create or replace function public.assign_shipment_output_identity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  base_code text;
begin
  if new.order_id is null then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.order_id is distinct from old.order_id then
    new.output_number := null;
    new.output_code := null;
  end if;

  -- Serializa únicamente las asignaciones del mismo pedido. Evita dos S02 si
  -- dos integraciones crean guías simultáneamente.
  perform pg_advisory_xact_lock(hashtextextended(new.order_id::text, 0));

  if new.output_number is null then
    select coalesce(max(s.output_number), 0) + 1
      into new.output_number
      from shipments s
     where s.order_id = new.order_id
       and s.id is distinct from new.id;
  end if;

  if new.output_code is null then
    select regexp_replace(
             upper(trim(leading '#' from coalesce(nullif(new.order_name, ''), o.name, ''))),
             '[^A-Z0-9_-]+',
             '',
             'g'
           )
      into base_code
      from orders o
     where o.id = new.order_id;
    if coalesce(base_code, '') <> '' then
      new.output_code := concat(base_code, '-S', lpad(new.output_number::text, 2, '0'));
    end if;
  end if;

  if new.qr_token is null then
    new.qr_token := gen_random_uuid();
  end if;
  return new;
end;
$$;

drop trigger if exists shipments_output_identity on shipments;
create trigger shipments_output_identity
before insert or update of order_id, order_name on shipments
for each row execute function public.assign_shipment_output_identity();

-- ----------------------------------------------------------------------------
-- Read-model MOM en modo sombra
-- ----------------------------------------------------------------------------

alter table order_master
  add column if not exists macro_stage text not null default 'por_confirmar'
    check (macro_stage in (
      'por_confirmar', 'preparacion', 'por_despachar',
      'en_curso', 'por_cerrar', 'finalizado'
    )),
  add column if not exists macro_substage text not null default 'sin_llamar',
  add column if not exists macro_reasons text[] not null default '{}'::text[],
  add column if not exists macro_operation text,
  add column if not exists macro_version text not null default 'mom-v1',
  add column if not exists macro_since timestamptz;

comment on column order_master.macro_stage is
  'Macroetapa MOM calculada en paralelo a general_status (modo sombra durante Fase 1).';
comment on column order_master.macro_reasons is
  'Motivos abiertos, especialmente en Por cerrar; pueden coexistir varios.';

create index if not exists order_master_macro_stage_idx
  on order_master(store_id, macro_stage, macro_since);
create index if not exists order_master_macro_substage_idx
  on order_master(store_id, macro_substage, macro_since);
create index if not exists order_master_macro_reasons_idx
  on order_master using gin(macro_reasons);
