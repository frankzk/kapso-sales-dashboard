-- Identificadores nuevos de WhatsApp en `leads`: BSUID y username.
--
-- Meta está migrando la identidad de WhatsApp del teléfono al BSUID (Business
-- Scoped User ID). Desde abril de 2026 los webhooks traen `user_id` junto al
-- teléfono; desde el rollout de usernames, un usuario que adopta uno puede dejar
-- de compartir su número, y `wa_id`/`from` pasan a venir AUSENTES (no vacíos).
--
-- Esto NO es urgente para nosotros: Kapso persiste teléfono y BSUID juntos en el
-- registro de la conversación, así que el mapeo se puede reconstruir desde ahí en
-- cualquier momento (los leads guardan `kapso_conversation_id`). Se guarda igual
-- para no depender de un tercero para reconstruir nuestra propia base.
--
-- Por ahora SOLO se escriben. Nada empareja ni deduplica por estos campos: la
-- clave sigue siendo (store_id, phone). Cambiar esa clave es el paso caro y
-- riesgoso, y no compra nada hasta que exista el primer lead sin teléfono — que
-- es justo lo que mide el contador `sinTelefono` del reporte de sync.
--
-- OJO al empezar a usarlos: un BSUID está scopeado a un BUSINESS PORTFOLIO, no a
-- un número ni a una WABA. La misma persona tiene un BSUID distinto en Aurela que
-- en Kenku, y no son comparables entre sí. Por eso la unicidad, cuando llegue el
-- momento, va por (store_id, bsuid) y nunca por bsuid solo.

alter table leads
  add column if not exists bsuid text,
  add column if not exists username text;

-- Formato: PE.xxxx… / US.xxxx…, con el segmento ENT en la variante "parent"
-- (US.ENT.xxxx…). Se valida la FORMA, no el contenido, para que un teléfono mal
-- ruteado a esta columna falle de entrada en vez de emparejar con la persona
-- equivocada más adelante. 135 caracteres: un parent BSUID es más largo de lo que
-- uno espera.
alter table leads
  drop constraint if exists leads_bsuid_format;
alter table leads
  add constraint leads_bsuid_format
  check (bsuid is null or bsuid ~ '^[A-Za-z]{2}\.(ENT\.)?[A-Za-z0-9]{1,128}$');

-- Búsqueda por BSUID dentro de una tienda: el orden de columnas es el de la clave
-- futura (store_id, bsuid). Parcial porque hoy casi todas las filas son null.
create index if not exists leads_store_bsuid
  on leads (store_id, bsuid)
  where bsuid is not null;
