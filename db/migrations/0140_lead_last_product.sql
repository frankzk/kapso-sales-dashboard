-- ============================================================================
-- 0140_lead_last_product.sql
-- Qué producto está consultando el lead AHORA, no el primer día.
--
-- EL PROBLEMA. El filtro «Producto» de la cola sacaba el producto de
-- `first_inbound_text`, y ese campo es de escritura única a propósito: es el
-- gancho de apertura para la asesora —«qué escribió primero»— y congelarlo
-- protege contra que una página que no lo puede leer lo borre.
--
-- Para la pregunta «¿qué escribió primero?» está bien. Para «¿qué quiere?» no,
-- por tres razones distintas y todas medidas:
--
--   1. UN LEAD POR TELÉFONO, PARA SIEMPRE. El upsert empareja por
--      (store_id, phone), así que quien vuelve meses después por otro producto
--      es la MISMA fila. En la base hay 2.596 leads que volvieron pasados 7
--      días o más, 1.157 de ellos ya compradores. Y `nextLeadState` los
--      reabre a propósito cuando traen un carrito nuevo: «a repeat customer
--      working a NEW purchase». Volvían a la cola con el producto de la
--      primera vez pegado.
--   2. SOLO SE MIRABA EL PRIMER MENSAJE. La señal salía de
--      `msgs.find(dir === "inbound")`. 1.301 leads abren con un saludo corto
--      sin link y mandan la ficha después: para ellos no había producto.
--   3. EL RECORTE A 240 CARACTERES ERA NUESTRO. 494 mensajes cortados, 413 con
--      link, y el corte caía a veces dentro de la URL. De ahí salían handles
--      rotos como `…-60-softge` o `keratin`, que luego había que replegar.
--
-- Esta columna guarda el handle del ÚLTIMO producto enlazado en la
-- conversación, leído del mensaje COMPLETO. No es de escritura única: cambia
-- cada vez que la clienta enlaza otra cosa, que es justamente el punto.
-- ============================================================================

alter table leads add column if not exists last_product_handle text;

comment on column leads.last_product_handle is
  'Handle del ultimo producto que el lead enlazo en la conversacion. Se actualiza en cada sync: responde que quiere AHORA, no que escribio el primer dia. Ver first_inbound_text para el gancho de apertura, que si es de escritura unica.';

-- El filtro agrupa por este valor, así que la cola lo pide por tienda.
create index if not exists leads_store_last_product_idx
  on leads(store_id, last_product_handle)
  where last_product_handle is not null;
