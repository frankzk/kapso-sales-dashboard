-- ============================================================================
-- 0329_lista_negra_requisito.sql — «Lista negra» unificada: cada alta a mano
-- elige lo que pide, y la búsqueda por celular tiene tope (MOM §41 y §41.11;
-- owner 09-11-2026).
--
-- POR QUÉ. Las dos listas que frenan el contra entrega —la automática
-- (`pago_online_*`, 0326) y la agregada a mano (`prepay_list_entries`,
-- 0309)— pasan a ser UNA «Lista negra» en pantalla. La automática pide el
-- adelanto de la escalera del §8 (o el pago completo, según su ajuste); la a
-- mano pedía siempre el total. Desde ahora cada alta a mano dice qué pide:
-- «Adelanto» (`adelanto`) o «Pago total» (`pago_completo`).
--
-- QUÉ CAMBIA.
--   * `prepay_list_entries.requirement`: `adelanto` o `pago_completo`. Las filas
--     de antes y el valor por defecto son `pago_completo`: hoy no cambia nada.
--     Como el motivo, no se reescribe (el trigger de la 0309 lo suma): para
--     pedir otra cosa, se saca y se agrega de nuevo.
--   * `lista_negra_searches`: una fila por búsqueda de la página (organización,
--     persona y cuándo; NUNCA el celular), para el tope por persona. Solo el
--     servidor la lee y la escribe.
--
-- El código tolera que esta migración falte: lee sin `requirement` (= el
-- total) y la búsqueda no tiene tope (el permiso sigue mandando). No cambia
-- datos. Correrla otra vez no cambia nada.
-- ============================================================================

alter table public.prepay_list_entries
  add column if not exists requirement text not null default 'pago_completo';

do $$ begin
  alter table public.prepay_list_entries
    add constraint prepay_list_entries_requirement_ck check (requirement in ('adelanto', 'pago_completo'));
exception when duplicate_object then null; end $$;

-- Lo escrito no se reescribe (0309), y lo que pide tampoco.
create or replace function public.prepay_list_entries_guard() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id
     or new.org_id is distinct from old.org_id
     or new.phone is distinct from old.phone
     or new.source is distinct from old.source
     or new.reason is distinct from old.reason
     or new.evidence is distinct from old.evidence
     or new.added_by is distinct from old.added_by
     or new.added_at is distinct from old.added_at
     or new.requirement is distinct from old.requirement then
    raise exception 'prepay_list_entries: una alta no se reescribe; quítala y agrega otra';
  end if;
  if old.removed_at is not null then
    raise exception 'prepay_list_entries: una alta quitada no se cambia ni se reabre';
  end if;
  -- `removed_known_order_ids` solo se escribe en la baja misma.
  if new.removed_known_order_ids is distinct from old.removed_known_order_ids and new.removed_at is null then
    raise exception 'prepay_list_entries: lo sabido al quitar se escribe solo al quitar';
  end if;
  return new;
end;
$$;

create table if not exists public.lista_negra_searches (
  id          bigint generated always as identity primary key,
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists lista_negra_searches_user_idx on public.lista_negra_searches (user_id, created_at desc);

alter table public.lista_negra_searches enable row level security;
-- Sin política: el navegador no la lee ni la escribe.
revoke all on public.lista_negra_searches from anon, authenticated;
grant all on public.lista_negra_searches to service_role;
grant usage, select on sequence public.lista_negra_searches_id_seq to service_role;
