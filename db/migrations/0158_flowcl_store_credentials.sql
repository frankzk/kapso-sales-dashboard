-- 0158_flowcl_store_credentials.sql — las credenciales de Flow.cl, por tienda.
--
-- POR QUÉ SE MUEVEN DEL ENTORNO. La 0157 las dejó en variables de entorno con
-- este argumento: Aurela y Kenku comparten UNA cuenta de Flow, y duplicar la
-- misma llave en dos filas garantiza que algún día se rote en una y se olvide
-- en la otra. El argumento era correcto y la conclusión no.
--
-- Una cuenta de Flow NO es configuración: es DÓNDE CAE EL DINERO. Está atada a
-- un RUC y a una cuenta bancaria. En cuanto venda una tienda que no sea de
-- Grupo GF, no puede compartir esa cuenta — sus cobros entrarían al banco de
-- otro. Eso no es una preferencia a futuro, es un límite duro, y conviene
-- cruzarlo antes de que exista la primera tienda de un tercero y no después.
--
-- SIN RESPALDO AL ENTORNO, A PROPÓSITO. Lo cómodo sería: si la tienda no tiene
-- llave, usa la global. Eso significa que una tienda nueva mal configurada
-- cobraría EN SILENCIO a la cuenta de Grupo GF. Sin respaldo, una tienda sin
-- credenciales simplemente no puede cobrar por pasarela y el botón no aparece:
-- el fallo es ruidoso y aburrido en vez de silencioso y caro.
--
-- El coste aceptado es el del argumento original: Aurela y Kenku llevarán la
-- misma llave en dos filas y alguien puede rotar una sola. Ese fallo se ve —los
-- cobros de la otra empiezan a dar 401— y se arregla en dos minutos. Cambiar
-- un 401 por plata mal enrutada es un buen trato.
--
-- El secreto del webhook también va por tienda, como flow_webhook_secret_enc
-- (Shopify Flow), kapso_webhook_secret_enc y aliclik_webhook_secret_enc:
-- `urlConfirmation` se elige en CADA cobro, así que nada obliga a compartirlo.

alter table stores
  add column if not exists flowcl_api_key_enc        text,
  add column if not exists flowcl_secret_key_enc     text,
  add column if not exists flowcl_webhook_secret_enc text;

comment on column stores.flowcl_api_key_enc is
  'apiKey de Flow.cl de ESTA tienda, cifrada. Identifica la cuenta de comercio '
  'donde cae el dinero: no se comparte entre tiendas de distinto titular.';
comment on column stores.flowcl_secret_key_enc is
  'secretKey de Flow.cl de esta tienda, cifrada. Firma cada petición (HMAC-SHA256).';
comment on column stores.flowcl_webhook_secret_enc is
  'Secreto que viaja en la urlConfirmation de esta tienda. Flow no firma sus '
  'avisos; el aviso solo dice "mira otra vez" y la verdad se relee con getStatus.';
