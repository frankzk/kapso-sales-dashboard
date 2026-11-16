# Cambio para Kenku y Aurela: la Lista negra no bloquea el contra entrega en Lima

**Para:** equipos de WordPress y COD Core de Kenku Perú y Aurela · **De:** Kapta · **Fecha:** 16-11-2026

Es un cambio al envío diario de la lista «Pago solo online» que ya reciben
(`docs/kapta/pago-solo-online.md`, endpoint `/wp-json/cod-core/v1/pago-solo-online`).
La dirección, las claves, la hora y el resto del contrato no cambian.

## 1. Qué decidió el owner

En **Lima** (Lima Metropolitana y Callao), un cliente de la lista **automática**
(«devolvió un pedido y nunca recibió», «anuló casi todos y nunca recibió») **sí
puede comprar contra entrega**: en Lima una entrega fallida casi no cuesta.
Fuera de Lima no cambia nada: solo pago online.

Los celulares que el equipo de Kapta **agregó a mano** (un fraude, una clienta
que avisó que no va a recibir) siguen sin contra entrega **en todas partes,
también en Lima**.

En Kapta ya rige desde el 16-11-2026: un pedido de Lima de la lista automática
se confirma y sale contra entrega.

## 2. Qué cambia en el envío

El cuerpo del `POST` suma un campo **`lima`**. Los campos de siempre no cambian:
`celulares` sigue llevando la Lista negra entera (la automática y la agregada a
mano).

```json
{
  "celulares": ["987654321", "912345678"],
  "correos": ["cliente@ejemplo.com"],
  "regla": "… · más 3 agregados a mano en Kapta",
  "lima": {
    "celulares": ["987654321"],
    "correos": ["cliente@ejemplo.com"],
    "distritos": [
      { "provincia": "Lima", "distrito": "Santiago de Surco" },
      { "provincia": "Callao", "distrito": "Ventanilla" }
    ]
  }
}
```

- `lima.celulares`: los celulares de `celulares` que **en Lima sí pueden pagar
  contra entrega** (los de la lista automática). Siempre son parte de
  `celulares`. Vienen en 9 dígitos, como los de siempre.
- `lima.correos`: lo mismo para los correos.
- `lima.distritos`: los distritos donde vale, con su provincia: los de Lima
  Metropolitana y los del Callao en los que Kapta entrega contra entrega. Hoy son
  todos menos **Pucusana**, que va por agencia. La lista la manda Kapta en cada
  envío, así que la tienda no tiene que mantener la suya.
- Igual que `celulares`, **cada envío reemplaza `lima` completo**. Si un envío
  no trae `lima`, nadie de la lista compra contra entrega, como hoy.

## 3. Qué tiene que hacer la tienda

Al decidir si ofrece «Pago contra entrega» (formulario de la ficha y checkout):

1. Si el celular (o el correo) **no está** en `celulares` (o `correos`):
   contra entrega normal, como hoy.
2. Si está, y **también** está en `lima.celulares` (o `lima.correos`), **y** la
   dirección de entrega es de un distrito de `lima.distritos` (misma provincia y
   mismo distrito): **contra entrega permitido**.
3. En cualquier otro caso: **solo pago online**, con el mensaje de siempre
   («Para este pedido solo podemos recibir el pago online»).

Detalles:

- **Comparar sin tildes, sin mayúsculas y sin espacios de más.** «San Martín de
  Porres» y «san martin de porres» son el mismo distrito.
- **La dirección es la de entrega** que eligió la clienta en el formulario (el
  departamento, la provincia y el distrito de `_cod_territorio`), no la de
  facturación.
- **Volver a mirarlo al enviar el pedido**, no solo al mostrar los métodos de
  pago: si la clienta cambia el distrito después, manda el último.
- **Las excepciones del panel de la tienda** (`-987654321`) y la **lista manual
  de la tienda** siguen igual.

## 4. Compatibilidad

- **Una tienda que todavía no lo implementa sigue bloqueando a todos, como
  hoy**: ignora `lima` y `celulares` trae a todos. No se rompe nada si Kapta lo
  manda antes.
- **Kapta empieza a mandar `lima` cuando nos confirmen** que el endpoint lo
  acepta (que un campo nuevo no haga fallar el envío). El cambio de Kapta es
  chico.
- El `GET` de verificación puede sumar `"lima": {"celulares": N, "correos": N,
  "distritos": N}` (solo totales, nunca los números), si les sirve para el panel.

## 5. Cómo probar

Con un `POST` propio al endpoint (las claves de WooCommerce de la tienda) y un
celular del equipo:

1. Mandar ese celular en `celulares` **y** en `lima.celulares`, con
   `lima.distritos` de ejemplo (Santiago de Surco, Lima).
2. En una ficha, con un distrito de Lima (por ejemplo, Santiago de Surco):
   **contra entrega disponible**.
3. Con un distrito de provincia (por ejemplo, Arequipa): **solo pago online**.
4. Mandar el celular solo en `celulares` (sin `lima`): en Surco, **solo pago
   online**.
5. No terminar ningún pedido de prueba en producción.

## 6. Datos personales

Igual que la lista de siempre: solo por esta API y por HTTPS; el `GET` y el
panel muestran totales, nunca números ni correos.
