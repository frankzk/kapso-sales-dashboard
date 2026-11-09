# Pedido para Kapta: lista automática de «pago solo online»

> **Nota de Kapta (09-11-2026): la lista que se manda es la «Lista negra» entera.** Además de los clientes que calcula la
> regla, `celulares` lleva los que el equipo de Kapta agrega a mano en su página «Lista negra» (un fraude, una clienta
> que avisó que no va a recibir), sin repetidos; `regla` lo dice («… · más N agregados a mano en Kapta»). El contrato
> no cambia. La lista manual del panel de la tienda sigue siendo de la tienda.

**Para:** equipo de Kapta · **De:** Kenku Perú y Aurela · **Fecha:** 09-11-2026

## 1. Qué queremos

Que la web de cada tienda **no le ofrezca contra entrega a quien ya tuvo una entrega fallida y nunca recibió un
pedido**. Esos clientes solo podrán pagar online (Flow: Yape o tarjeta).

Por qué, con datos de Kapta de los últimos 180 días (contra entrega, Lima y provincia):

| Cliente que hace un pedido nuevo | Pedidos | Se entregó |
|---|---|---|
| Sin entregas fallidas antes | 29,596 | 78 % |
| 1 entrega fallida antes y ninguna recibida | 539 | 52 % |
| 2 o más fallidas antes y ninguna recibida | 48 | 44 % |

Por debajo de ~64 % de entrega, el contra entrega deja menos que el pago adelantado. Son unos 100 pedidos al mes
entre las dos tiendas.

La tienda ya tiene todo lo necesario para recibir la lista y aplicarla. **Kapta tiene que construir tres cosas:** el
cálculo diario de la lista (sección 3), el envío a las dos tiendas (sección 4) y el uso de la misma lista en los
pedidos que crea Kapta, Chatby, el bot o las asesoras (sección 5).

## 2. Regla (decidida por el owner)

Un cliente entra a la lista si cumple **las dos condiciones**:

1. Tiene **al menos una entrega fallida**: un pedido contra entrega `devuelto`, o `anulado` **después de salir**
   (`dispatched_at` con fecha).
2. **No tiene ninguna entrega recibida**: ningún pedido `entregado`.
   *(Kapta, 09-11-2026: cuenta CUALQUIER pedido entregado del celular, también por agencia o de la
   migración de plataforma. Si ya recibió una vez, sale de la lista.)*

Detalles:

- **Kenku y Aurela juntos:** se mira el historial de las dos tiendas (son los mismos clientes) y se manda **la misma
  lista a las dos**.
- **Todo el historial** que tenga Kapta, no solo los últimos días.
- **Solo pedidos contra entrega** (`coverage` = `lima` o `provincia_cod`). Los pedidos por agencia o pagados no
  cuentan como fallas.
- **Un anulado antes de salir no es una falla:** es un cliente que canceló al confirmar.
- **Sale de la lista** en cuanto recibe un pedido (por ejemplo, uno que pagó online y se le entregó). Como cada envío
  reemplaza la lista completa, basta con que deje de cumplir la regla.
- **Cliente = celular.** Se identifica por los **últimos 9 dígitos** del celular. El correo es opcional (sección 3.2).

> **Nota de Kapta (09-11-2026): la regla final del owner cambió, y la lista de Kapta manda.** Lo de arriba y la
> consulta de referencia de la sección 3.1 eran la propuesta de las tiendas. La regla que Kapta aplica y manda es:
>
> - Mismo cliente (últimos 9 dígitos), Kenku y Aurela juntas, todo el historial, solo contra entrega.
> - **No cuentan para nada** (ni como falla ni como entrega) los pedidos con un hecho de la **migración de
>   plataforma** en Kapta (`cancelled_woocommerce`, `legacy_shopify_sale_cancelled`, `woo_sale_ended_pending_return`):
>   son artefactos del cambio de Shopify a WooCommerce, no clientes que no recibieron.
> - Con **cero `entregado`**, entra si **(A)** tiene al menos un `devuelto`, o **(B)** tiene **5 o más** pedidos y el
>   **75 % o más** están `anulado` (antes o después de salir: el «anulador»).
> - Un `anulado` después de salir, **solo, ya no basta**.
>
> Así, la consulta de la sección 3.1 ya no reproduce la lista. No importa: las tiendas no la calculan, reciben la de
> Kapta cada día. Medido el 09-11-2026: ~3.149 clientes (3.141 por devuelto y 6 «anuladores»).

## 3. Pieza 1: cálculo diario de la lista

### 3.1 Celulares

Una tarea programada **una vez al día** (sugerido: **05:00 de Lima**, antes del primer pico de pedidos), con esta
consulta como referencia:

```sql
with h as (
  select right(regexp_replace(coalesce(customer_phone, ''), '\D', '', 'g'), 9) as celular,
    count(*) filter (where general_status = 'devuelto'
      or (general_status = 'anulado' and dispatched_at is not null)) as fallidas,
    count(*) filter (where general_status = 'entregado') as recibidas
  from order_master
  where coverage in ('lima', 'provincia_cod')   -- solo contra entrega
  group by 1
)
select celular from h
where length(celular) = 9 and fallidas >= 1 and recibidas = 0
order by celular;
```

Hoy daría alrededor de **500 celulares**.

### 3.2 Correos (opcional)

La tienda también puede bloquear por correo, pero **el celular es lo principal**: en el formulario contra entrega el
correo es opcional y la mayoría no lo pone. Si Kapta guarda el correo de los pedidos (por ejemplo, el
`billing.email` de los pedidos de WooCommerce), puede mandar también los correos de los mismos clientes. Si no lo
guarda, se manda solo la lista de celulares y está bien.

## 4. Pieza 2: envío a las dos tiendas

Después de calcular la lista, Kapta la manda **a cada tienda por separado**, con la misma lista:

| Tienda | Dirección |
|---|---|
| Kenku Perú | `https://kenku.pe/wp-json/cod-core/v1/pago-solo-online` |
| Aurela | `https://aurela.pe/wp-json/cod-core/v1/pago-solo-online` |

### 4.1 Autenticación

**Las mismas claves de la API REST de WooCommerce que Kapta ya usa** para leer pedidos de cada tienda (permiso
**lectura/escritura**), con autenticación básica por HTTPS: usuario = *consumer key*, contraseña = *consumer secret*.
No hacen falta claves nuevas.

### 4.2 Pedido

`POST`, con `Content-Type: application/json`:

```json
{
  "celulares": ["987654321", "912345678"],
  "correos": ["cliente@ejemplo.com"],
  "regla": "1+ entrega fallida y 0 recibidas, Kenku y Aurela, calculada 2026-11-10 05:00"
}
```

- **Cada envío reemplaza la lista automática completa. No suma.** Siempre se manda la lista entera vigente.
- `celulares`: la tienda toma los últimos 9 dígitos, así que da igual si vienen con `51`, `+51` o espacios.
- `correos`: opcional; la tienda los pasa a minúsculas y descarta los inválidos.
- `regla`: texto libre que se muestra en el panel de la tienda. Conviene poner la fecha del cálculo.
- **Máximo:** 50 000 celulares y 50 000 correos por envío.
- **Para vaciar la lista** se manda `{"celulares": [], "correos": []}`.

### 4.3 Respuesta

`200`:

```json
{
  "descartados": 3,
  "celulares": 512,
  "correos": 140,
  "actualizado": "2026-11-10T10:00:02+00:00",
  "regla": "1+ entrega fallida y 0 recibidas, Kenku y Aurela, calculada 2026-11-10 05:00"
}
```

- `celulares` y `correos`: cuántos quedaron guardados.
- `descartados`: repetidos o inválidos.

Errores posibles:

| Código | Qué significa | Qué hacer |
|---|---|---|
| `401` / `403` | Claves inválidas o sin permiso de escritura | Revisar las claves de esa tienda; no reintentar en bucle |
| `413` | Más de 50 000 celulares o correos | Avisarnos |
| `5xx` o tiempo agotado | La tienda no respondió | Reintentar hasta 3 veces (1, 5 y 15 minutos después) |

Si después de los reintentos falla, la tienda **se queda con la lista anterior**, que sigue funcionando. Kapta debe
**avisar al equipo** (por ejemplo, por Telegram) si el envío de una tienda falla dos días seguidos.

### 4.4 Verificación

`GET` a la misma dirección, con las mismas claves, devuelve los totales y la fecha del último envío, **sin los
números**:

```json
{"celulares": 512, "correos": 140, "actualizado": "2026-11-10T10:00:02+00:00", "regla": "…"}
```

Sugerimos que Kapta muestre en su panel, por tienda, la fecha y el total del último envío exitoso.

### 4.5 Alerta de cambio brusco

Si la lista nueva tiene **más del doble o menos de la mitad** que la del día anterior, mejor no mandarla y avisar
(suele ser un error en el cálculo). El crecimiento normal es de unos pocos clientes por día.

## 5. Pieza 3: los pedidos que crea Kapta, Chatby, el bot o las asesoras

La tienda **no bloquea** los pedidos que entran por la API (Kapta, bot, asesoras). A esos les agrega en la **nota del
pedido** el texto `// POSIBLE FRAUDE - NO ENVIAR SI NO SE TIENE EL PAGO` (configurable en la tienda), que se lee en el
campo `customer_note` de la API.

Kapta tiene que aplicar la misma regla de su lado:

1. **Al confirmar un pedido contra entrega** (por cualquier canal), si el celular está en la lista del día:
   **no despachar contra entrega.** Pedir el **pago completo online** (link de Flow o Yape) o un **adelanto**, según
   lo que decida el owner.
2. **Chatby y el bot:** al tomar un pedido de un celular de la lista, ofrecer directamente el pago online en vez de
   contra entrega.
3. Usar **la lista que calcula Kapta** (sección 3), no la nota del pedido. La nota solo sirve de aviso para quien mira
   el pedido.

## 6. Cómo probar antes de mandar la lista real

Kapta nunca se conecta al staging, así que la prueba es en producción, con un celular del equipo:

1. `POST` a kenku.pe con `{"celulares": ["<celular del equipo>"], "regla": "prueba"}` → `200` con `"celulares": 1`.
2. `GET` → muestra `"celulares": 1` y la fecha.
3. En una ficha de kenku.pe, llenar el formulario con ese celular y elegir **contra entrega** → tiene que salir
   «Para este pedido solo podemos recibir el pago online» y **no se crea el pedido**. Con otro celular, el contra
   entrega funciona normal. (No terminar el pago online: no hacemos pedidos de prueba en producción.)
4. Repetir en aurela.pe.
5. Mandar la lista real.

**Criterio de terminado:** las dos tiendas reciben la lista todos los días, el panel de cada tienda (WooCommerce →
Ajustes → Avanzado → COD Core → «Pago solo online») muestra el total y la fecha del día, y Kapta aplica la regla en los
pedidos que crea él mismo.

## 7. Datos personales

- La lista son datos personales. **Solo viaja por esta API, por HTTPS.** Nada por chat, correo, Telegram,
  hojas de cálculo ni repositorios.
- El `GET` y el panel muestran solo totales, nunca los números.
- El aviso de Telegram de la sección 4.3 no lleva celulares ni correos.

## 8. Lo que ya hace la tienda (para referencia)

- **Formulario de la ficha:** si el cliente elige contra entrega y su celular o correo está en la lista, rechaza el
  pedido con «Para este pedido solo podemos recibir el pago online» y le deja pagar con Flow.
- **Checkout clásico:** no muestra contra entrega a esa persona.
- **Excepciones:** el equipo puede sacar a alguien de la lista automática desde el panel de la tienda con una línea
  `-987654321` o `-correo@dominio.com`. Aunque Kapta lo vuelva a mandar, no se le bloquea.
- **Lista manual:** el equipo también puede agregar a mano celulares, correos, nombres o direcciones en el mismo
  panel. Esa lista no la toca el envío de Kapta.
- **Disponible desde:** cod-core 0.10.45. Les avisamos el día que esté en producción en las dos tiendas. Antes de
  eso la dirección responde `404`.

## 9. Preguntas para Kapta

1. ¿Guardan el correo de los pedidos? Si no, se manda solo la lista de celulares.

   **Respuesta de Kapta (09-11-2026):** sí, en una parte de los pedidos (el `billing.email` de los de WooCommerce y el
   `email` de los de Shopify). Kapta manda el correo de un cliente de la lista **solo si ese correo aparece con un único
   celular** en los pedidos de Kenku y Aurela: un correo compartido (la familia, el de una asesora) bloquearía a alguien
   que no está en la lista. Medido hoy: 80 de los ~3.149 clientes de la lista tienen correo. El celular sigue siendo
   lo principal.

2. ¿A qué hora les conviene correr el cálculo? (Sugerido: 05:00 de Lima.)

   **Respuesta de Kapta:** a las 05:00 de Lima (10:00 UTC), como sugieren. Los reintentos (1, 5 y 15 minutos) caben en
   esa misma hora.

3. En los pedidos de la lista que confirman las asesoras, ¿cobran el pago completo o un adelanto? Lo decide el owner.

   **Decisión del owner (09-11-2026): adelanto.** En los pedidos que crean Kapta, Chatby, el bot o las asesoras, el
   cliente de la lista paga el **adelanto de la escalera del §8 del MOM** (S/ 20, `ADELANTO_MINIMO`) validado antes de
   confirmar o de sacar la guía contra entrega, o el pago online completo. Es un ajuste de Kapta («Adelanto (regla §8)»,
   por defecto, o «Pago completo») en Automatizaciones → «Pago solo online (lista automática)», y se puede cambiar. En la
   web de la tienda no cambia nada: ahí el cliente de la lista solo paga online. Detalle en el MOM §41.11.
