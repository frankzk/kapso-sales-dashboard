-- ============================================================================
-- 0280_leads_order_id_idx.sql — el lead de un pedido, por índice (MOM §16.1,
-- «Un comprobante por validar se ve en el Master y en Leads», 25-10-2026).
--
-- «Atender ahora» sube a la clienta que ya pagó y espera la validación de su
-- comprobante. Para encontrarla se buscan los leads de esos pedidos por
-- `leads.order_id`, y `leads` no tenía índice sobre esa columna: medido el
-- 25-10-2026, un recorrido completo de ~70.000 filas (≈ 38 ms) para devolver
-- 16. Esa lectura corre en cada carga de Leads y en cada pasada del refresco en
-- vivo de sus contadores, así que se paga muchas veces al día.
--
-- Parcial: solo los leads que tienen pedido (la mayoría no lo tiene).
--
-- EL CÓDIGO NO LO NECESITA PARA FUNCIONAR: sin el índice la consulta es la
-- misma y devuelve lo mismo, solo más lenta. Por eso puede salir antes.
--
-- EN PRODUCCIÓN SE CREA A MANO, con `create index concurrently` (DEPLOY.md):
-- un `create index` normal bloquea las escrituras en `leads` mientras se
-- construye. Aquí queda con `if not exists` para la base de CI y las nuevas.
-- ============================================================================

-- Aun con el índice ya creado, `if not exists` toma por un instante un bloqueo
-- de escritura sobre `leads` antes de ver que existe: si tuviera que esperar a
-- otra transacción, que falle en limpio en vez de encolar escrituras.
set lock_timeout = '5s';
create index if not exists leads_order_id_idx
  on public.leads (order_id)
  where order_id is not null;
reset lock_timeout;

comment on index public.leads_order_id_idx is
  'El lead de un pedido: «Atender ahora» sube a quien tiene un comprobante por validar (MOM §16.1, 0280).';
