// El adelanto mínimo que se le pide a una clienta de agencia. UN número, UN sitio.
//
// POR QUÉ ESTÁ SOLO EN ESTE ARCHIVO. Vivía en `pickup-key.ts` como constante, y
// además copiado como «30» a mano en siete sitios más: dos comprobaciones —el
// servidor que crea Olva y el KPI de «Adelanto de Agencia»— y cinco textos que
// lo decían en pantalla. El día que hubo que bajarlo, el número de la constante
// y los siete números sueltos podían separarse en silencio: el sistema habría
// aceptado S/ 20 mientras la pantalla seguía pidiendo S/ 30. Este archivo no
// importa nada para que cualquier módulo pueda leerlo sin arriesgar un ciclo.
//
// POR QUÉ 20 Y NO 30 (08-09-2026). Se aceptaban S/ 20 a diario: de 78 adelantos
// de S/ 20 cargados, 76 se validaron —el 97 %—. Con el mínimo en 30, esos 76
// pedidos quedaban con `payment_state: adelanto_cargado` —como si nadie los
// hubiera revisado—, el panel decía «Faltan S/ 10.00 para el adelanto mínimo»
// sobre plata que el equipo ya había aceptado, y en Agencia el pedido no salía
// de confirmación (#KP133181). Se baja el número a lo que la operación ya hace.
//
// «DE MOMENTO», dijo quien lo decidió. Es negociable por naturaleza, así que si
// vuelve a moverse, se mueve aquí y en ningún otro sitio: hay una prueba que
// falla si alguien vuelve a escribir el número a mano fuera de este archivo.
//
// QUÉ NO CAMBIA CON ESTE NÚMERO. La clave de recojo no depende de él:
// `canRevealPickupKey` exige que el dinero cubra el TOTAL del pedido. Bajar el
// mínimo del adelanto no suelta ningún paquete antes de cobrarlo entero.

export const ADELANTO_MINIMO = 20;

/** Para textos: «S/ 20». Un solo formato, para que el número se vea igual en todos lados. */
export const ADELANTO_MINIMO_LABEL = `S/ ${ADELANTO_MINIMO}`;
