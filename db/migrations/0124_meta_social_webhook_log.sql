-- 0124 — Bitácora cruda de los webhooks de página de Facebook e Instagram.
--
-- POR QUÉ UNA BITÁCORA Y NO LA TABLA DEFINITIVA
--
-- Es una SONDA. Antes de construir la bandeja de comentarios hay tres preguntas
-- que hoy son opinión y que ninguna documentación contesta con certeza:
--
--   1. ¿Cuántos comentarios al día llegan, por página y por cuenta de IG?
--   2. ¿Cuántos son sobre ANUNCIOS y cuántos orgánicos?
--   3. ¿Llegan siquiera los de anuncios? — Las fuentes se contradicen: un hilo
--      del foro de Meta dice que sí aparecen junto a los orgánicos, y las
--      comparativas de herramientas dicen que la cobertura de comentarios en
--      anuncios es poco fiable. Como el volumen del negocio está casi todo en
--      anuncios, esa duda decide si el proyecto entero tiene sentido.
--
-- Se responden mirando entregas reales durante una semana, no diseñando a
-- ciegas. Y de paso se aprende la FORMA del payload, que es lo que después se
-- convierte en el parser de la versión buena sin adivinar un solo campo.
--
-- Misma doctrina que 0104 (Chatby): guardar entero y no interpretar. La razón
-- allá era que no había forma de pedir el histórico; acá es que interpretar sin
-- payloads reales delante es exactamente el error que este repositorio ya pagó
-- —una vez con `created_via`, otra con los descartes de handoff— y que se
-- resume en «probar, no deducir».
--
-- POR QUÉ NO LLEVA `store_id`, igual que la de Chatby
--
-- El webhook de Meta se configura POR APP, no por página: una sola URL cubre
-- Aurela y Kenku. La tienda tendrá que salir de `entry[].id` (el id de la página
-- o de la cuenta de Instagram), que es justo uno de los datos que esta sonda
-- viene a recoger. Escribirlo a ciegas sería peor que dejarlo fuera: mandaría
-- los comentarios de una tienda a la bandeja de la otra.
--
-- LO QUE SÍ SE EXTRAE es solo el SOBRE, que Meta sí documenta y es estable en
-- todos sus webhooks: `object`, los `entry[].id` y los `field` de cada cambio.
-- Eso no es adivinar el formato, es su vocabulario. Todo lo demás queda crudo.

create table if not exists meta_social_webhook_log (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  -- "page" | "instagram". Lo primero que hay que saber de una entrega.
  object_type text,
  -- id de la página de Facebook o de la cuenta de Instagram. Es lo que un día
  -- resolverá la tienda, y por eso se indexa desde el principio.
  entry_ids text[] not null default '{}',
  -- "feed", "comments", "mentions"… qué venía en esta entrega. Responde sola la
  -- pregunta de si los comentarios llegan y por qué campo.
  fields text[] not null default '{}',
  -- Nombres de las cabeceras recibidas, SIN valores: uno de ellos es la firma,
  -- derivada de nuestro app secret. Sirve para descubrir qué manda Meta de
  -- verdad (id de entrega, reintentos) sin guardar nada sensible.
  header_names text[] not null default '{}',
  -- ¿El cuerpo era JSON válido? Si no, `payload` lo conserva como {"_raw": "…"}
  -- en vez de descartarlo.
  parsed boolean not null default true,
  payload jsonb not null
);

-- El uso durante la sonda es "las últimas N entregas" y "cuántas por día".
create index if not exists meta_social_webhook_log_recent
  on meta_social_webhook_log (received_at desc);
-- Y "todo lo de esta página", que es el paso previo a resolver la tienda.
create index if not exists meta_social_webhook_log_entries
  on meta_social_webhook_log using gin (entry_ids);

revoke all on table meta_social_webhook_log from public, anon, authenticated;
grant all on table meta_social_webhook_log to service_role;

alter table meta_social_webhook_log enable row level security;

-- SIN POLÍTICAS A PROPÓSITO: RLS activo y cero policies = nadie lee salvo
-- service_role, que salta RLS. Acá hay texto escrito por clientes y todavía no
-- se puede acotar por tienda (no sabemos de cuál es cada fila). Hasta que exista
-- esa columna, cerrado del todo es la única postura defendible: abrirlo por
-- `authenticated` enseñaría los comentarios de una tienda a la otra.
