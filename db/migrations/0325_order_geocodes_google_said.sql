-- ============================================================================
-- 0325_order_geocodes_google_said.sql — Lo que dijo Google, guardado junto al
-- veredicto, y la versión de la reja de la calle (MOM §6.1 y §38; owner,
-- 09-11-2026).
--
-- POR QUÉ. #KP204099 (Kenku, Provincia COD, Chiclayo): la clienta confirmó por
-- Chatby con «Av. quiñones N° 546» y Google dio «Av. José Quiñones 546,
-- Chiclayo» con el número de la cuadra (`RANGE_INTERPOLATED`). La reja de la
-- calle (0316) pedía que CADA palabra del nombre de Google estuviera en la
-- dirección, y la clienta no escribió «José»: quedó `otra_calle` y la ficha
-- dijo «Google no da el edificio de esa dirección», cuando Google la había
-- encontrado. `order_geocodes` solo guardaba el veredicto: nadie podía ver qué
-- encontró Google ni repetir la cuenta.
--
-- QUÉ AGREGA (aditiva: no reescribe ninguna fila; las de antes quedan con null).
--   * `google_label`: el `formatted_address` del primer resultado de Google.
--   * `google_route`: el `long_name` del componente `route` (la calle).
--   * `google_number`: el `long_name` de `street_number`.
--     Las tres se llenan en cada consulta que se guarda. Las lee la ficha
--     (pestaña Chatby) para decir «Google encontró: … No se usó porque …».
--   * `approx_rule`: con qué versión de la reja de la calle se guardó
--     `approx_kind` (lib/geocode-approx.ts, `APPROX_STREET_RULE`). 1 (o null,
--     las filas de la 0316) = cada palabra; 2 = además el sufijo («Av. Quiñones»
--     = «Avenida José Quiñones»). Un `otra_calle` con una versión anterior se
--     vuelve a consultar UNA vez, solo desde la guía automática de Chatby
--     (pedidos de Provincia COD dentro de su ventana, sin coordenada ni
--     ubicación de WhatsApp). Nada más se vuelve a consultar.
--
-- Sin esta migración el código guarda lo de la 0316 y no vuelve a consultar.
-- `order_geocodes` sigue sin políticas: solo la lee y escribe el servidor (0301).
-- ============================================================================

alter table public.order_geocodes add column if not exists google_label text;
alter table public.order_geocodes add column if not exists google_route text;
alter table public.order_geocodes add column if not exists google_number text;
alter table public.order_geocodes add column if not exists approx_rule smallint;

alter table public.order_geocodes drop constraint if exists order_geocodes_approx_rule_check;
alter table public.order_geocodes add constraint order_geocodes_approx_rule_check
  check (approx_rule is null or approx_rule between 1 and 100);
-- Lo que dijo Google tiene tope: es el texto de una dirección, no un documento.
alter table public.order_geocodes drop constraint if exists order_geocodes_google_said_check;
alter table public.order_geocodes add constraint order_geocodes_google_said_check check (
  coalesce(length(google_label), 0) <= 500
  and coalesce(length(google_route), 0) <= 200
  and coalesce(length(google_number), 0) <= 50
);

comment on column public.order_geocodes.google_label is 'formatted_address del primer resultado de Google (0325).';
comment on column public.order_geocodes.google_route is 'long_name del componente route de Google (0325).';
comment on column public.order_geocodes.google_number is 'long_name del componente street_number de Google (0325).';
comment on column public.order_geocodes.approx_rule is
  'Versión de la reja de la calle con que se guardó approx_kind (0325): null/1 = cada palabra, 2 = también el sufijo.';
