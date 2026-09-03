-- ============================================================================
-- 0142_ad_product_declarations.sql
-- Un anuncio puede cambiar de producto, y la declaración tiene fecha.
--
-- EL CASO REAL. El anuncio 120248301757360056 de Kenku aparece con dos
-- titulares distintos —«Tu café favorito, ahora saludable ☕🌿» y
-- «GC WIN ICE COFFEE 2007 (11).mp4»— y sus leads llegan escribiendo «Quiero
-- más información del Gel de Limpieza de Lengua». El creativo del café se
-- reutilizó para vender otra cosa, que es una práctica normal: un creativo que
-- funciona no se tira.
--
-- Con una sola declaración por anuncio, ese anuncio no tiene respuesta buena.
-- Declararlo «café» etiqueta mal a quien preguntó por el gel; declararlo «gel»
-- etiqueta mal a los que entraron cuando sí era café. Y lo hace HACIA ATRÁS,
-- reescribiendo el pasado de leads ya trabajados, sin que nada avise.
--
-- Así que la declaración deja de ser un hecho eterno y pasa a tener fecha: este
-- anuncio vendió ESTO DESDE tal día. El lead toma la que estaba vigente el día
-- que entró, no la última que alguien escribió.
--
-- LA PRIMERA DECLARACIÓN VALE DESDE SIEMPRE (`-infinity`). Es lo correcto y
-- además conserva lo que ya había: mientras nadie diga que el anuncio cambió,
-- lo que se sabe de él vale para todos sus leads. Poner fecha es la excepción,
-- no el trámite de cada día.
-- ============================================================================

create table if not exists ad_product_declarations (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references stores(id) on delete cascade,
  ad_id             text not null,
  -- Una declaración SIEMPRE dice qué producto. No hay «firmado sin decir qué»:
  -- eso era un sí que no significaba nada, y aquí ni siquiera cabe.
  product_handle    text not null,
  -- Desde cuándo vale. `-infinity` = desde siempre, que es la primera.
  valid_from        timestamptz not null default '-infinity',
  -- Por qué se abrió un periodo nuevo («se reutilizó el creativo del café»).
  -- Sin esto, dentro de tres meses nadie sabe por qué un anuncio tiene dos.
  note              text,
  declared_by       uuid references auth.users(id) on delete set null,
  declared_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (length(trim(ad_id)) > 0),
  check (length(trim(product_handle)) > 0)
);

-- Dos declaraciones del mismo anuncio no pueden empezar el mismo instante: no
-- habría forma de decir cuál gana, y el desempate silencioso es peor que el
-- error.
create unique index if not exists ad_product_declarations_periodo_uniq
  on ad_product_declarations(store_id, ad_id, valid_from);
-- La consulta de la cola: los periodos de estos anuncios, del más nuevo al más
-- viejo, para quedarse con el primero que empiece antes de que el lead entrara.
create index if not exists ad_product_declarations_lookup_idx
  on ad_product_declarations(store_id, ad_id, valid_from desc);

comment on table ad_product_declarations is
  'Que producto vendio cada anuncio y DESDE CUANDO. Un anuncio reutilizado tiene varias filas; el lead toma la vigente el dia que entro.';
comment on column ad_product_declarations.valid_from is
  '-infinity = desde siempre (la primera declaracion). Una fecha real abre un periodo nuevo sin reescribir el pasado.';

drop trigger if exists ad_product_declarations_touch on ad_product_declarations;
create trigger ad_product_declarations_touch before update on ad_product_declarations
  for each row execute function public.touch_updated_at();

alter table ad_product_declarations enable row level security;

drop policy if exists ad_product_declarations_select on ad_product_declarations;
create policy ad_product_declarations_select on ad_product_declarations
  for select to authenticated using (store_id in (select auth_store_ids()));

drop policy if exists ad_product_declarations_write on ad_product_declarations;
create policy ad_product_declarations_write on ad_product_declarations
  for all to authenticated
  using (store_id in (select id from stores where org_id in (select auth_admin_org_ids())))
  with check (store_id in (select id from stores where org_id in (select auth_admin_org_ids())));

-- Lo ya declarado se muda con `valid_from = -infinity`: nadie dijo que esos
-- anuncios hubieran cambiado de producto, así que su declaración vale para
-- todos sus leads, igual que antes de esta migración.
insert into ad_product_declarations (store_id, ad_id, product_handle, valid_from, declared_by, declared_at)
select store_id, ad_id, trim(product_handle), '-infinity', confirmed_by, coalesce(confirmed_at, now())
  from ad_products
 where confirmed_at is not null and coalesce(trim(product_handle), '') <> ''
on conflict (store_id, ad_id, valid_from) do nothing;

-- Y se van de `ad_products`, que se queda con lo que siempre fue suyo: el
-- titular del anuncio y la SUGERENCIA del histórico. Dejarlas duplicadas en las
-- dos tablas era garantizar que un día dijeran cosas distintas — el fallo que
-- este repo repite.
alter table ad_products drop column if exists product_handle;
alter table ad_products drop column if exists confirmed_by;
alter table ad_products drop column if exists confirmed_at;
drop index if exists ad_products_confirmed_idx;

comment on table ad_products is
  'Lo que se sabe de cada anuncio de Meta: su titular y la sugerencia del historico. Que producto vende, y desde cuando, vive en ad_product_declarations.';
