-- ============================================================================
-- 0243_telnyx_webrtc_credentials.sql — la credencial de Telnyx de cada persona
-- para llamar desde la computadora (MOM §8.5, 11-10-2026).
--
-- QUÉ ES. La ficha del pedido llama a la clienta desde el navegador (Telnyx
-- WebRTC): la asesora habla con audífonos y la clienta ve el número de la
-- empresa. El navegador entra a Telnyx con un token que dura 24 horas, y el
-- token sale de una «credencial de telefonía» que vive en Telnyx, colgada de
-- la conexión SIP de credenciales (`TELNYX_WEBRTC_CONNECTION_ID`).
--
-- POR QUÉ UNA POR PERSONA. Telnyx lo pide así —cada usuario, su credencial—
-- y así el registro de Telnyx dice quién llamó. Se crea la primera vez que la
-- persona llama y se reutiliza; esta tabla solo recuerda cuál es.
--
-- `connection_id` se guarda para saber de qué conexión es: si un día la
-- conexión cambia, la credencial vieja no sirve y se crea otra.
--
-- Solo la lee y la escribe el servidor (`service_role`). No guarda nada
-- secreto —el id de la credencial no basta para llamar sin la clave de la API—,
-- pero tampoco hay motivo para que la vea el navegador.
-- ============================================================================

create table if not exists telnyx_webrtc_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  credential_id text not null,
  connection_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table telnyx_webrtc_credentials is
  'Credencial de telefonía de Telnyx de cada persona, para llamar desde la computadora (MOM §8.5). Solo el servidor.';

alter table telnyx_webrtc_credentials enable row level security;
revoke all on telnyx_webrtc_credentials from anon, authenticated;
grant all privileges on telnyx_webrtc_credentials to service_role;
