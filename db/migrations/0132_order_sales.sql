-- order_sales — de quién es la venta, decidido UNA vez y para siempre.
--
-- POR QUÉ EXISTE. Hasta ahora "de quién es el cierre" no se guardaba en ningún
-- sitio: se DEDUCÍA cada vez que cargaba el tablero, a partir de tres cosas que
-- cambian solas —`lead_calls`, `leads.category` y `leads.order_id`—. Por eso las
-- ventas se movían de asesora sin que nadie tocara nada:
--
--   • #KP130367: Daphne registró la venta a las 22:57:26 (S/ 298). A las
--     22:57:58, TREINTA Y DOS SEGUNDOS después, otra asesora mandó un "gracias
--     por la confianza" y se llevó el cierre, por ser el último toque.
--   • #KP124652: la clienta compró dos veces con un mes de diferencia. El lead
--     solo tiene UNA casilla `order_id`, así que la venta de julio de una
--     asesora apareció colgada de otra en agosto, con el pedido equivocado.
--   • Y 7 de los 47 cierres del 25/08 los registró una persona distinta de la
--     que aparecía acreditada.
--
-- Todos son el mismo fallo: el hecho ya estaba en la base —una fila `sale` con
-- autora, hora y monto— y el sistema prefería adivinar por quien habló al final.
--
-- QUÉ CAMBIA. La atribución pasa de calculada a REGISTRADA. Una fila por pedido,
-- escrita en el instante de la venta, con la asesora que apretó el botón. No hay
-- nada que recalcular, así que no hay nada que se pueda mover.
--
-- APPEND-ONLY, y no por gusto: es justo lo que se pidió —"que no se traspase"—.
-- Sin UPDATE no hay traspaso posible ni por un bug, no solo por convención. La
-- PK en `order_id` remata la garantía: la primera venta registrada es la dueña,
-- y un segundo intento choca en vez de sobrescribir.
--
-- LOS PEDIDOS SIN FILA SON CORRECTOS, no un vacío que rellenar. En 60 días, de
-- 5.010 pedidos con lead, 2.365 no tuvieron NUNCA a una asesora tocando el lead:
-- son compras self-service de la web. Ponerles dueña sería inventarla.

create table if not exists order_sales (
  order_id    uuid primary key references orders(id) on delete cascade,
  store_id    uuid not null references stores(id) on delete cascade,
  -- Quién apretó "generar pedido". NO es "quién atendió el lead": es el autor de
  -- una acción concreta y auditable. Sin `on delete`: en una tabla append-only un
  -- `set null` sería un UPDATE que el trigger rechaza, y además la columna es NOT
  -- NULL. Borrar a una asesora que tiene ventas queda bloqueado, que es lo
  -- correcto — sus cierres son parte del histórico del negocio.
  vendedora   uuid not null references auth.users(id),
  -- El lead desde el que se vendió, congelado. `leads.order_id` apunta al ÚLTIMO
  -- pedido de la clienta, así que no sirve para mirar hacia atrás; esto sí.
  -- Sin FK a propósito: es contexto, no integridad, y una FK obligaría a elegir
  -- entre bloquear la limpieza de leads o un UPDATE que el trigger rechaza.
  lead_id     uuid,
  occurred_at timestamptz not null default now(),
  -- sale_action = registrada en vivo por la acción de venta.
  -- backfill_match = reconstruida del histórico (ver el bloque de abajo).
  source      text not null default 'sale_action',
  created_at  timestamptz not null default now()
);

-- El tablero pregunta siempre lo mismo: las ventas de una tienda en un rango,
-- por asesora.
create index if not exists order_sales_store_occurred_idx
  on order_sales (store_id, occurred_at desc);
create index if not exists order_sales_vendedora_idx
  on order_sales (vendedora, occurred_at desc);

alter table order_sales enable row level security;

drop policy if exists order_sales_select on order_sales;
create policy order_sales_select on order_sales for select to authenticated
  using (store_id in (select auth_store_ids()));

-- Sin update/delete NI SIQUIERA para service_role: la vía de la API queda
-- cerrada por privilegios y el trigger es defensa en profundidad para quien
-- entre por psql con otro rol (mismo patrón que `order_events`, 0045).
grant select on order_sales to authenticated;
grant select, insert on order_sales to service_role;

drop trigger if exists order_sales_append_only on order_sales;
create trigger order_sales_append_only before update or delete on order_sales
  for each row execute function public.reject_mutation();

-- ----------------------------------------------------------------------------
-- Backfill del histórico
-- ----------------------------------------------------------------------------
-- La fila `sale` de `lead_calls` ya trae la autora y la hora, pero NO trae el
-- pedido: la tabla no tiene `order_id` y de 2.486 notas, CERO llevan el código
-- (dicen el monto y los productos, nunca el "#KP…"). Así que el pedido hay que
-- reconstruirlo, y lo que lo identifica es la coincidencia en el tiempo: la
-- venta y el pedido nacen del mismo click, con uno o dos segundos de diferencia.
--
-- Con una ventana de ±2 min sobre 60 días el match salió limpio: 2.375 pedidos
-- con EXACTAMENTE una venta candidata y solo 6 ambiguos (0,25%). Los ambiguos se
-- descartan — mejor sin dueña que con la dueña equivocada, que es el problema
-- que vinimos a arreglar.
--
-- El emparejamiento va POR TELÉFONO, no por `leads.order_id`. Esa casilla solo
-- recuerda el último pedido de la clienta, así que atarse a ella dejaría fuera
-- justo los casos que motivaron todo esto: las compras anteriores de una clienta
-- recurrente (#KP124652 y sus 35 hermanos). Se comparan los últimos 9 dígitos
-- —el móvil peruano— dentro de la misma tienda, y ahí no hay ambigüedad posible:
-- `leads` es único por (store_id, phone), así que un teléfono es exactamente un
-- lead. Lo que el emparejamiento tiene que resolver no es QUÉ lead, sino cuál de
-- sus ventas corresponde a este pedido — y eso lo decide la ventana.
--
-- Idempotente: `on conflict do nothing` deja intactas las filas ya registradas
-- en vivo, que son más fiables que cualquier reconstrucción.
--
-- VA EN UNA FUNCIÓN, no suelto, por dos razones. La prueba de `verify-db.sh`
-- ejecuta ESTA MISMA función contra sus fixtures, así que lo que se prueba es lo
-- que corre —no una copia del SQL que se despegaría a la primera—. Y si alguna
-- vez falla la escritura en vivo, volver a llamarla recupera esa venta: la fila
-- `sale` de `lead_calls` sigue ahí. Es la vía de recuperación que promete
-- `lib/order-sale.ts`.

create or replace function public.backfill_order_sales()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  insertadas integer;
begin
insert into order_sales (order_id, store_id, vendedora, lead_id, occurred_at, source)
select m.order_id, m.store_id, m.vendedora, m.lead_id, m.occurred_at, 'backfill_match'
from (
  -- El group by va por PEDIDO, que es la unidad que se atribuye: así
  -- `candidatas` cuenta las ventas que se disputan ESE pedido y `= 1` significa
  -- "no hay duda". Con una sola candidata los min() devuelven la única fila.
  --
  -- No hace falta agrupar también por lead: `leads` tiene único (store_id,
  -- phone), así que dentro de una tienda un teléfono es un solo lead. Lo que sí
  -- pasa —y es el caso que descarta el `= 1`— es que un mismo lead tenga dos
  -- filas `sale` dentro de la ventana.
  select o.id        as order_id,
         o.store_id  as store_id,
         min(l.id::text)::uuid         as lead_id,
         min(lc.vendedora::text)::uuid as vendedora,
         min(lc.occurred_at)           as occurred_at,
         count(*)                      as candidatas
  from orders o
  join leads l
    on l.store_id = o.store_id
   and right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 9)
     = right(regexp_replace(coalesce(o.customer_phone, ''), '\D', '', 'g'), 9)
   and length(regexp_replace(coalesce(o.customer_phone, ''), '\D', '', 'g')) >= 9
  join lead_calls lc
    on lc.lead_id = l.id
   and lc.kind = 'sale'
   and lc.vendedora is not null
   and lc.occurred_at between o.created_at - interval '2 minutes'
                          and o.created_at + interval '2 minutes'
  group by o.id, o.store_id
) m
where m.candidatas = 1
on conflict (order_id) do nothing;
  get diagnostics insertadas = row_count;
  return insertadas;
end;
$fn$;

revoke all on function public.backfill_order_sales() from public;

select public.backfill_order_sales();
