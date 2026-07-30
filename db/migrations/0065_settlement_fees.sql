-- 0065 — La liquidación también trae la comisión del courier, y a veces no trae guía.
--
-- Con el primer reporte real en la mano (Axel Courier, Lima Metropolitana) salen
-- dos cosas que 0064 no previó:
--
--   1. LA HOJA DECLARA LO QUE EL COURIER SE QUEDA. La columna GANANCIA es la
--      tarifa que Axel cobra POR ENTREGA y que descuenta del depósito: cobran
--      S/ 2,219.73 y depositan S/ 2,073.73, quedándose S/ 146.00. Es un costo
--      logístico declarado fila a fila, así que se guarda fila a fila. Sin esto
--      el cuadre del depósito daría siempre un faltante igual a la comisión.
--
--   2. NO SIEMPRE HAY GUÍA. El reporte de Axel identifica cada entrega por
--      NOMBRE del cliente y DISTRITO, sin guía ni nº de pedido. Se guardan
--      ambos para poder emparejar por ahí y, sobre todo, para que la cola de
--      revisión muestre a un humano de quién es la fila que no se pudo vincular.
--      Un nombre no es un identificador: lo que empata por nombre y distrito
--      queda igual sujeto a revisión cuando hay más de un candidato.

alter table rider_settlement_lines
  add column if not exists declared_fee   numeric(12, 2),
  add column if not exists customer_name  text,
  add column if not exists district       text;

comment on column rider_settlement_lines.declared_fee is
  'Comisión que el courier declara cobrarse por esta entrega (columna GANANCIA). '
  'Se descuenta del depósito esperado; no es un pago al motorizado.';
comment on column rider_settlement_lines.customer_name is
  'Nombre del cliente tal como lo escribe el courier. Pista de emparejamiento '
  'cuando la hoja no trae guía ni nº de pedido, nunca un identificador.';

-- Emparejar por nombre dentro de la tienda es una búsqueda frecuente en cuanto
-- la hoja no trae guía; sin índice se convierte en un escaneo por liquidación.
create index if not exists rider_settlement_lines_name_idx
  on rider_settlement_lines(settlement_id, lower(customer_name))
  where customer_name is not null;

-- El courier de la liquidación: hasta ahora se deducía del motorizado, pero una
-- hoja como la de Axel es del COURIER entero, no de una persona.
alter table rider_settlements
  add column if not exists courier      text,
  add column if not exists pos_fee      numeric(12, 2) not null default 0;

comment on column rider_settlements.courier is
  'Courier que emite la liquidación (axel, aliclik…). Nulo = motorizado propio.';
comment on column rider_settlements.pos_fee is
  'Comisión de POS declarada aparte en la hoja (fila COMISION). Se descuenta '
  'del depósito esperado igual que las comisiones por entrega.';
