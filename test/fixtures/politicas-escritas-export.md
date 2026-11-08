# Políticas escritas — Kenku Peru y Aurela

Nov 8, 2026

## Cómo usar este documento

Cada bloque de abajo es una política lista para pegar en Kapta: **Automatizaciones › Conector de IA › Políticas escritas**, eligiendo la tienda y pulsando «Nueva política». Grok Bot lee solo las vigentes, y lo que no esté escrito no lo inventa.

| Campo en Kapta | Qué va | Tope |
| --- | --- | --- |
| Título | El nombre de la política | 2 a 80 caracteres |
| Texto | Lo que el agente le puede decir al cliente, tal cual | 4000 caracteres |
| Vale desde | El día en que empieza a valer (día de Lima) | — |
| Hasta | Opcional: el último día en que vale | — |
| Fuente | Opcional: de dónde sale la regla | 200 caracteres |

- Lo que ya dice el sistema (Kapta, el MOM, lo que hoy dicen el bot y el agente de voz) va escrito tal cual, con su fuente.
- Lo que solo puede decidir el dueño va como **\[CONFIRMAR: …\]**. No pegues un bloque con \[CONFIRMAR\] sin reemplazarlo: el agente lo diría tal cual.
- El adelanto mínimo y la cobertura por distrito no hace falta escribirlos: Kapta los calcula y el agente ya los recibe.

## Kenku Peru

Cinco políticas salen del bot de Kapso de Kenku (la copia del repo es del 13-09-2026) y tres las tiene que escribir el dueño. Vale desde: el día en que las pegues.

### Pago contraentrega

En Lima y en las zonas con contraentrega, el pedido llega a la dirección y se paga al recibir, sin adelanto. Se puede pagar en efectivo, con tarjeta de crédito o débito, Yape, Plin o transferencia bancaria. Lo más común es efectivo o Yape.

Fuente: bot de Kapso de Kenku (check-coverage).

### Envío por agencia Shalom

Cuando el destino no tiene contraentrega, el pedido se envía a la agencia u oficina de Shalom que elija el cliente. Se separa con un adelanto de **\[CONFIRMAR: S/ 30 o S/ 20\]** que va a cuenta del total, y el saldo se paga antes de recoger. El pedido se confirma con el voucher del adelanto. Para recoger en la agencia se necesita el DNI y la clave de recojo, que se envía cuando el total está pagado.

Fuente: bot de Kapso de Kenku (check-coverage) y Kapta (clave de recojo, MOM §12).

### Envío por Olva Courier

Por Olva Courier el pago es anticipado y completo, y el envío va a una dirección exacta. El pedido se confirma con el voucher del pago.

Fuente: bot de Kapso de Kenku (check-coverage).

### Cómo pagar por adelantado

Los adelantos y los pagos anticipados se hacen por Yape a Grupo GF SAC (la razón social de Kenku), al 930 555 309. Después se envía el voucher o la captura por WhatsApp para confirmar el pedido. **\[CONFIRMAR: que ese Yape sigue vigente y si hay otra cuenta\]**

Fuente: bot de Kapso de Kenku (check-coverage).

### Entrega el mismo día en Lima

En Lima y Callao, un pedido confirmado antes de las 10:00 puede llegar hoy. Entre las 10:00 y las 12:00 puede llegar hoy entre las 3 p. m. y las 8 p. m. Después de las 12:00 ya no sale el mismo día. **\[CONFIRMAR: que se sigue ofreciendo\]**

Fuente: bot de Kapso de Kenku (ventana del mismo día).

### Cambios y devoluciones

**\[CONFIRMAR: el plazo para pedir un cambio (por ejemplo, 7 días desde que llegó), en qué estado debe estar el producto, si se devuelve el dinero o solo se cambia, quién paga el envío y a quién se escribe\]**

Fuente: el dueño. Hoy no está en ningún sitio del sistema.

### Garantía

**\[CONFIRMAR: qué cubre, por cuánto tiempo y qué hace el cliente si un producto llega dañado o no funciona\]**

Fuente: el dueño.

### Horario de atención

**\[CONFIRMAR: los días y horas en que responde una asesora por WhatsApp\]**

Fuente: el dueño.

## Aurela

Las mismas ocho políticas que Kenku, salvo el pago contraentrega: el bot de Aurela ofrece solo efectivo o Yape. Fuente: bot de Kapso de Aurela (la copia del repo es del 13-09-2026).

### Pago contraentrega

En Lima y en las zonas con contraentrega, el pedido llega a la dirección y se paga al recibir, sin adelanto, en efectivo o por Yape.

Fuente: bot de Kapso de Aurela (check-coverage).

### Envío por agencia Shalom

Cuando el destino no tiene contraentrega, el pedido se envía a la agencia u oficina de Shalom que elija el cliente. Se separa con un adelanto de **\[CONFIRMAR: S/ 30 o S/ 20\]** que va a cuenta del total, y el saldo se paga antes de recoger. El pedido se confirma con el voucher del adelanto. Para recoger en la agencia se necesita el DNI y la clave de recojo, que se envía cuando el total está pagado.

Fuente: bot de Kapso de Aurela (check-coverage) y Kapta (clave de recojo, MOM §12).

### Envío por Olva Courier

Por Olva Courier el pago es anticipado y completo, y el envío va a una dirección exacta. El pedido se confirma con el voucher del pago.

Fuente: bot de Kapso de Aurela (check-coverage).

### Cómo pagar por adelantado

Los adelantos y los pagos anticipados se hacen por Yape a Grupo GF SAC, al 930 555 309. Después se envía el voucher o la captura por WhatsApp para confirmar el pedido. **\[CONFIRMAR: que ese Yape sigue vigente para Aurela y si hay otra cuenta\]**

Fuente: bot de Kapso de Aurela (check-coverage).

### Entrega el mismo día en Lima

En Lima y Callao, un pedido confirmado antes de las 10:00 puede llegar hoy. Entre las 10:00 y las 12:00 puede llegar hoy entre las 3 p. m. y las 8 p. m. Después de las 12:00 ya no sale el mismo día. **\[CONFIRMAR: que se sigue ofreciendo en Aurela\]**

Fuente: bot de Kapso de Aurela (ventana del mismo día).

### Cambios y devoluciones

**\[CONFIRMAR: el plazo para pedir un cambio, en qué estado debe estar el producto, si se devuelve el dinero o solo se cambia, quién paga el envío y a quién se escribe\]**

Fuente: el dueño.

### Garantía

**\[CONFIRMAR: qué cubre, por cuánto tiempo y qué hace el cliente si un producto llega dañado o no funciona\]**

Fuente: el dueño.

### Horario de atención

**\[CONFIRMAR: los días y horas en que responde una asesora por WhatsApp\]**

Fuente: el dueño.

## Lo que tiene que decidir el dueño

Hay siete puntos. El primero es una contradicción que hoy ya existe entre el bot y Kapta.

- [ ] **Adelanto de Shalom: S/ 30 o S/ 20.** El bot de las dos tiendas pide S/ 30. Kapta acepta S/ 20 como mínimo desde el 08-09-2026 («de momento», `lib/adelanto-minimo.ts`), y eso es lo que el agente ya recibe en las políticas calculadas. Si queda en S/ 30, hay que subir el número en Kapta; si queda en S/ 20, hay que cambiar el texto del bot.
- [ ] **Cambios y devoluciones**, por tienda: el plazo, el estado del producto, si se devuelve el dinero o solo se cambia, y quién paga el envío.
- [ ] **Garantía**, por tienda: qué cubre y por cuánto tiempo.
- [ ] **Horario de atención** por WhatsApp.
- [ ] **El Yape 930 555 309 a nombre de Grupo GF SAC**: confirmar que sigue vigente para las dos tiendas.
- [ ] **La entrega el mismo día en Lima**: confirmar que se sigue ofreciendo, con sus cortes de las 10:00 y las 12:00.
- [ ] **El bot de hoy.** La copia del bot que hay en el repo es del 13-09-2026. Si el bot cambió en Kapso desde entonces, lo que diga hoy manda: revisa estos textos contra el bot antes de pegarlos.
