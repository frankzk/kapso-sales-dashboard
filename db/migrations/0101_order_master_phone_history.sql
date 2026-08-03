-- 0101 — Índice para el historial del cliente por teléfono.
--
-- La ficha previa a la llamada (§8) busca los pedidos anteriores del MISMO
-- teléfono, sin filtrar por tienda: el cliente es la misma persona compre en
-- Kenku o en Aurela, y unos anulados en una tienda son un antecedente en la
-- otra. La RLS ya limita lo que cada quien puede ver.
--
-- El índice que existía —`order_master(store_id, customer_phone)`, de 0045— no
-- sirve para esa consulta: el teléfono no es su primera columna, así que buscar
-- solo por teléfono recorre la tabla entera. Con ~11.500 pedidos hoy pasa
-- desapercibido; se paga en cada apertura de un pedido en confirmación, que es
-- la pantalla donde más se abre y cerrar.
--
-- Parcial: un pedido sin teléfono no tiene historial que buscar, y son
-- suficientes para que valga la pena no indexarlos.

create index if not exists order_master_phone_history_idx
  on order_master(customer_phone)
  where customer_phone is not null;

comment on index order_master_phone_history_idx is
  'Historial del cliente por teléfono, entre tiendas (MOM §8.1).';
