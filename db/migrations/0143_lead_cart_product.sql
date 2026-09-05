-- ============================================================================
-- 0143_lead_cart_product.sql
-- El producto del CARRITO, por handle y no por título.
--
-- EL PROBLEMA. Los leads que llegan con carrito o navegación abandonada caen en
-- «Sin producto» aunque sean los que más claro tienen qué quieren. Lo que
-- guardábamos de ellos era `cart_summary`, un TÍTULO:
--
--   carrito:  «Nails Repairing – Sérum Tea Tree Ginger para Uñas (30ml)»
--   link:     `nails-repairing-suero-reparador-de-unas`
--
-- El mismo producto escrito de dos maneras. Emparejar título con handle es
-- adivinar, y adivinar es exactamente lo que este filtro existe para no hacer:
-- juntar mal dos productos manda a la asesora con el argumentario equivocado.
--
-- Así que se pide el handle a quien lo tiene. Shopify lo da en la línea del
-- borrador (`lineItems.product.handle`) y es el MISMO identificador que trae el
-- link, así que el lead del carrito y el de la ficha caen en el mismo balde sin
-- que nadie tenga que emparejar textos.
--
-- POR QUÉ COLUMNA PROPIA Y NO `last_product_handle`. Son dos escritores
-- distintos —la sincronización de conversaciones y la de borradores— y no
-- llegan en un orden garantizado. Compartiendo columna, la que corriera después
-- pisaría a la otra: un carrito viejo borraría el link que el cliente mandó
-- esta mañana. Separadas, el orden lo decide la pantalla y está escrito en un
-- solo sitio.
-- ============================================================================

alter table leads add column if not exists cart_product_handle text;

comment on column leads.cart_product_handle is
  'Handle del producto del carrito o de la navegacion abandonada. Es el MISMO identificador que trae el link /products/<handle>, para que los dos leads caigan en el mismo balde. cart_summary sigue siendo el titulo legible para la asesora.';

create index if not exists leads_store_cart_product_idx
  on leads(store_id, cart_product_handle)
  where cart_product_handle is not null;
