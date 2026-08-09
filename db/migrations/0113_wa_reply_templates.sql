-- ============================================================================
-- 0113_wa_reply_templates.sql — catálogo de plantillas aprobadas que el asesor
-- puede enviar A MANO desde el drawer cuando la ventana de 24 h está cerrada.
--
-- Por qué una tabla y no columnas en `stores`, como las otras automatizaciones
-- (`browse_`, `winback_`, `drip_`, `cart_seq_`, `return_recovery_`): esas envían
-- UNA plantilla fija cada una, y una columna por flujo alcanza. Acá el asesor
-- ELIGE, así que son N por tienda y crecen sin desplegar.
--
-- Por qué se configura en vez de leerse de Kapso: Kapso no expone un endpoint
-- para listar plantillas, y el de Meta (`GET /{waba_id}/message_templates`)
-- necesita el WABA id, que no guardamos en ninguna parte. Mientras no exista una
-- de las dos cosas, el catálogo se escribe a mano contra lo aprobado en Meta.
-- ============================================================================
create table if not exists wa_reply_templates (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references stores(id) on delete cascade,
  -- Lo que ve el asesor en el desplegable. El nombre de Meta no sirve de
  -- etiqueta: son cosas como `recuperacion_devolucion_v3`.
  label         text not null,
  -- El nombre EXACTO aprobado en Meta. Si no coincide, Meta rechaza con 132001
  -- y el asesor no tiene forma de saber por qué desde el drawer.
  template_name text not null,
  language      text not null default 'es',
  -- El cuerpo aprobado, con {{1}}, {{2}}… tal cual. No se envía: se pinta para
  -- que el asesor LEA lo que está a punto de mandar. Sin esto elegiría a ciegas
  -- entre nombres de plantilla, que es como no elegir.
  body_preview  text,
  -- Qué va en {{1}}, {{2}}… Lista ordenada de TOKENS, no de texto, igual que
  -- `stores.return_recovery_params` (0112). Cada tienda es una WABA distinta con
  -- su propia aprobación, así que el orden se configura, no se compila.
  -- Tokens válidos en lib/wa-reply-templates.ts.
  params        text not null default '',
  -- Retirar una plantilla sin borrarla: Meta las pausa o las deja obsoletas, y
  -- borrar la fila perdería a qué apuntaba un envío ya registrado en el outbox.
  active        boolean not null default true,
  sort          integer not null default 0,
  created_at    timestamptz not null default now(),
  -- La misma plantilla en el mismo idioma no se carga dos veces por tienda.
  unique (store_id, template_name, language)
);

create index if not exists wa_reply_templates_store_idx
  on wa_reply_templates (store_id, sort, created_at);

comment on column wa_reply_templates.params is
  'Orden de los parámetros del cuerpo, por token: nombre, producto, monto, distrito, tienda. Debe coincidir con la plantilla aprobada en Meta.';
comment on column wa_reply_templates.body_preview is
  'Cuerpo aprobado en Meta con {{n}} sin sustituir. Solo para mostrar; nunca se envía.';

alter table wa_reply_templates enable row level security;

-- Leer: cualquiera que ya vea la tienda, porque el desplegable del drawer lo
-- necesita. Escribir: NADIE desde el navegador. El alta pasa por Ajustes, que
-- exige admin de la organización y escribe con el rol de servicio. Un nombre de
-- plantilla mal escrito no rompe un chat: le baja la calidad a la WABA entera.
drop policy if exists wa_reply_templates_select on wa_reply_templates;
create policy wa_reply_templates_select on wa_reply_templates for select to authenticated
  using (store_id in (select auth_store_ids()));

grant select on wa_reply_templates to authenticated;
grant all privileges on wa_reply_templates to service_role;
