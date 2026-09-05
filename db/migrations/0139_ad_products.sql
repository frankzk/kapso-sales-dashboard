-- ============================================================================
-- 0139_ad_products.sql
-- Qué producto vende cada anuncio de Meta.
--
-- EL PROBLEMA. El filtro «Producto» de la cola de leads saca el producto del
-- link que el cliente trae en su primer mensaje. Funciona para quien llegó
-- desde la ficha, pero el 82 % de los leads sin producto (1.061 de 1.294)
-- vienen de un anuncio: tocan el anuncio, se les abre WhatsApp con un mensaje
-- genérico y nunca pasan por la ficha. De ellos solo tenemos `ad_id`.
--
-- El titular del anuncio NO sirve como producto. Cuatro anuncios de Beewax
-- llegan con tres titulares distintos —«✨ Brillo Natural para tu Madera»,
-- «beewax 1107 fk (6).mp4», «beewax 1107 fk (5).mp4»—, dos de ellos nombres de
-- archivo de video, y uno de los anuncios trae «{{product.name}}» sin
-- renderizar. Agrupar por titular parte un producto en tres baldes.
--
-- LO QUE ESTA TABLA ES, Y LO QUE NO ES. Es una DECLARACIÓN: alguien dice qué
-- vende un anuncio y firma. `evidence_*` guarda lo que el histórico sugiere
-- —qué compraron los leads de ese anuncio— pero una sugerencia NO etiqueta a
-- nadie: mientras `confirmed_at` sea null, sus leads siguen en «Sin producto».
--
-- Por qué esa frontera. La evidencia histórica es fuerte en unos anuncios y
-- floja en otros: hay uno con 42 % de producto dominante. Etiquetar con eso
-- manda a la asesora con el argumentario equivocado más de la mitad de las
-- veces, y peor: sin saber que está adivinando. Una cola que dice «no sé» es
-- trabajable; una que miente con confianza, no.
--
-- La clave es el HANDLE de Shopify, el mismo que sale del link, para que un
-- lead de anuncio y uno de ficha del mismo producto caigan en el MISMO balde.
-- ============================================================================

create table if not exists ad_products (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references stores(id) on delete cascade,
  -- El id del anuncio en Meta, tal como llega en `leads.ad_id`.
  ad_id             text not null,
  -- El handle de Shopify (`beewax-cera-de-abeja-natural`). Null mientras nadie
  -- lo declare: el anuncio existe en la lista, sin producto asignado.
  product_handle    text,
  -- Último titular visto, solo para reconocer el anuncio en la pantalla de
  -- asignación. No se usa para agrupar NADA.
  ad_headline       text,
  -- Lo que sugiere el histórico: el TÍTULO del producto más comprado por los
  -- leads de este anuncio, su porcentaje y sobre cuántas líneas se midió.
  --
  -- Es un título, no un handle, y esa diferencia es deliberada. Los pedidos
  -- guardan «Beewax™ - Cera de abeja natural…» y el link guarda
  -- `beewax-cera-de-abeja-natural`: emparejarlos sería adivinar, que es
  -- justamente lo que esta tabla existe para no hacer. El título se le MUESTRA
  -- a quien firma; el handle lo elige esa persona.
  suggested_label   text,
  evidence_pct      smallint check (evidence_pct between 0 and 100),
  evidence_sample   integer check (evidence_sample >= 0),
  -- La firma. Sin ella la fila es una sugerencia y no etiqueta a ningún lead.
  confirmed_by      uuid references auth.users(id) on delete set null,
  confirmed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (length(trim(ad_id)) > 0),
  -- Confirmar es decir QUÉ producto vende, no solo que alguien miró. Una fila
  -- confirmada sin handle sería un «sí» que no dice nada y volvería a dejar a
  -- sus leads sin producto sin que nadie entienda por qué.
  check (confirmed_at is null or coalesce(trim(product_handle), '') <> '')
);

create unique index if not exists ad_products_store_ad_uniq
  on ad_products(store_id, ad_id);
-- La consulta de la cola: los anuncios CONFIRMADOS de estas tiendas.
create index if not exists ad_products_confirmed_idx
  on ad_products(store_id, ad_id)
  where confirmed_at is not null;

comment on table ad_products is
  'Qué producto vende cada anuncio de Meta. Solo las filas con confirmed_at etiquetan leads; el resto son sugerencias del histórico.';
comment on column ad_products.suggested_label is
  'Titulo del producto mas comprado por los leads de este anuncio. Es una pista para quien firma, no un handle: no etiqueta a nadie.';
comment on column ad_products.evidence_pct is
  'Qué tan dominante es la sugerencia (0-100). Se muestra al confirmar para que quien firma sepa si está firmando un 98 % o un 42 %.';

drop trigger if exists ad_products_touch on ad_products;
create trigger ad_products_touch before update on ad_products
  for each row execute function public.touch_updated_at();

alter table ad_products enable row level security;

drop policy if exists ad_products_select on ad_products;
create policy ad_products_select on ad_products
  for select to authenticated using (store_id in (select auth_store_ids()));

-- Declarar qué vende un anuncio cambia cómo se lee la cola entera de esa
-- tienda, así que lo firma quien administra la organización, no cualquiera que
-- pase por la pantalla.
drop policy if exists ad_products_write on ad_products;
create policy ad_products_write on ad_products
  for all to authenticated
  using (store_id in (select id from stores where org_id in (select auth_admin_org_ids())))
  with check (store_id in (select id from stores where org_id in (select auth_admin_org_ids())));
