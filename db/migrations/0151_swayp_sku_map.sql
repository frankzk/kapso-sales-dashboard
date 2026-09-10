-- ============================================================================
-- 0151_swayp_sku_map.sql — mapeo SKU de Shopify → código de barras de Swayp.
--
-- EL PROBLEMA. Swayp acepta los productos de una guía de dos formas, y ellos
-- mismos descartan una:
--
--   productos: [{ codbar, cantidad, nombre }]   ← estructurada, por código
--   contenido: "2 x NOMBRE EXACTO"              ← «tiende a ser inestable
--                                                  porque se busca por nombre
--                                                  y no por código» (Swayp)
--
-- Vamos por `codbar`. Buscar por nombre ata el descuento de stock a que su
-- catálogo y el nuestro escriban igual un producto: cambian una tilde y las
-- guías dejan de descontar sin que nadie se entere.
--
-- POR QUÉ HACE FALTA UNA TABLA. Los dos catálogos no tienen relación. El mismo
-- producto es `765545233` en Shopify y `AURE001` en Swayp; el más vendido es
-- `PRUEBA-ETHIOPIAN` acá y `AURE003` allá. No hay regla que los derive: es una
-- decisión de una persona, producto por producto.
--
-- POR QUÉ NO HAY ESPEJO DEL CATÁLOGO, como sí lo hay para Aliclik (0055). El
-- espejo sirve cuando existe de dónde copiarlo. El desplegable del panel de
-- Swayp consulta algún endpoint de referencias, pero todavía no nos lo han
-- documentado; crear una tabla que nadie puede llenar sería inventar una fuente
-- que no existe. Cuando lo den, el espejo se añade y esta tabla no cambia — que
-- es justo la razón de que el mapeo viva separado.
--
-- Aplicar DESPUÉS de supabase/policies.sql (usa auth_store_ids()).
-- Nota 0053: Supabase concede TODO por defecto sobre cada tabla nueva, así que
-- hay que revocar antes de conceder.
-- ============================================================================

create table if not exists swayp_sku_map (
  store_id     uuid not null references stores(id) on delete cascade,
  -- SKU tal y como llega en orders.line_items[].sku, normalizado (trim+upper)
  -- por lib/swayp-productos.ts. Sin normalizar, «ABC » y «abc» serían dos
  -- entradas para el mismo producto y una de las dos nunca se encontraría.
  shopify_sku  text not null,
  -- El código de barras de Swayp: «AURE001». Es lo que viaja en
  -- productos[].codbar y lo único que ellos leen para descontar stock.
  codbar       text not null,
  -- Nombre en Swayp, solo para que la pantalla muestre a qué se mapeó sin
  -- tener que consultarles. No decide nada: si difiere del suyo, manda el
  -- codbar.
  nombre       text,
  note         text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (store_id, shopify_sku)
);

-- Para responder «¿qué producto de Shopify apunta a este codbar?» cuando haya
-- que revisar un descuento de stock que no cuadra.
create index if not exists swayp_sku_map_codbar_idx on swayp_sku_map(store_id, codbar);

alter table swayp_sku_map enable row level security;

drop policy if exists swayp_sku_map_select on swayp_sku_map;
create policy swayp_sku_map_select on swayp_sku_map for select to authenticated
  using (store_id in (select auth_store_ids()));

revoke all on swayp_sku_map from anon, authenticated, service_role;
grant select         on swayp_sku_map to authenticated;
grant all privileges on swayp_sku_map to service_role;
