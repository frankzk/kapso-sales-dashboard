-- El N° de pedido que se quedó sin copiar en los envíos ya vinculados.
--
-- QUÉ PASA. `shipments.order_name` es una COPIA denormalizada de `orders.name`.
-- Hay 601 envíos donde el enlace existe —`matched`, con `order_id` apuntando a
-- un pedido real— pero la copia quedó vacía. En pantalla se ve contradictorio:
-- el cajón lista los productos del pedido y a la vez el encabezado dice
-- "Pedido —".
--
-- LO CARO NO ES LA PANTALLA. De esos 601, **189 están anulados y no se pueden
-- reprogramar**: la guía Fenix de reemplazo se autogenera a partir del número de
-- pedido, y sin número el botón se queda bloqueado. Cada uno exige que alguien
-- entre al cajón, pulse "Cambiar", busque el pedido a mano y lo vuelva a
-- enlazar — para acabar escribiendo el mismo nombre que ya está en `orders`.
--
-- POR QUÉ SE PUEDE ARREGLAR SIN RIESGO. No se inventa nada ni se decide nada: el
-- enlace ya está hecho y `orders.name` es la fuente de verdad de ese campo. Esto
-- solo termina una copia a medias.
--
-- ACOTADO A PROPÓSITO. Solo toca filas donde la copia está VACÍA y el pedido
-- enlazado SÍ tiene nombre. Nunca pisa un valor existente —una copia distinta al
-- pedido enlazado sería otro problema, y taparlo acá lo escondería— y nunca
-- escribe null sobre null.
--
-- Y NO ARREGLA LA CAUSA, que sigue sin identificarse: los 601 están repartidos
-- entre varios `match_method`, la mayoría `manual`, y todos los escritores de
-- ese campo que se revisaron sí lo escriben. Por eso el código además resuelve
-- el nombre leyendo el pedido enlazado cuando la copia falta
-- (`effectiveOrderName`): así un envío no vuelve a quedar bloqueado aunque la
-- copia se escriba vacía otra vez.

update shipments s
   set order_name = o.name
  from orders o
 where o.id = s.order_id
   and s.order_name is null
   and o.name is not null;
