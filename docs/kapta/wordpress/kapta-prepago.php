<?php
/**
 * RETIRADO (owner, 09-11-2026, MOM §41.7): no instalar. Las altas a mano de la
 * «Lista negra» de Kapta llegan a la tienda en el envío diario de la lista
 * automática (COD Core 0.10.45, `/wp-json/cod-core/v1/pago-solo-online`). Se
 * deja como referencia del contrato `/prepago`, que Kapta sigue contestando.
 *
 * Plugin Name: Kapta · Lista de pago adelantado
 * Description: Esconde «Pago contra entrega» en el checkout a los celulares que Kapta tiene en su «Lista de pago adelantado» (lista negra). MOM §41.
 * Version: 1.1.0
 * Requires PHP: 7.4
 * Author: Kapta
 *
 * QUÉ HACE (decisión del owner, 05-11-2026).
 *   Quien rechazó un pedido en la puerta o no lo recogió en la agencia paga el
 *   TOTAL por adelantado. En el checkout de WooCommerce este plugin le pregunta
 *   a Kapta, con el celular de facturación, si ese cliente está en la lista:
 *     - si lo está, quita «Pago contra entrega» (`cod`) de los métodos de pago;
 *     - al pagar, vuelve a comprobarlo y rechaza `cod` con un mensaje claro
 *       (ocultar el botón no basta: un formulario se puede mandar a mano);
 *     - cuando la clienta cambia el celular, recalcula los métodos de pago.
 *
 * FALLA ABIERTO. Si Kapta no responde (caído, lento, mal configurado), el
 * checkout sigue como siempre y deja pagar contra entrega: Kapta frena ese
 * pedido igual en «Por confirmar» y no le crea guía hasta que pague el total.
 * Una caída de Kapta nunca deja a la tienda sin vender, y tampoco la vuelve
 * lenta: se pregunta una vez por celular en cada pedido de página y, si Kapta
 * no contesta, nadie vuelve a esperarlo durante un minuto.
 *
 * NO ES UN BUSCADOR DE LA LISTA. Que el checkout esconda `cod` dice si un
 * celular está en la lista; por eso cada visitante pregunta como mucho 3
 * celulares distintos cada 10 minutos (`kapta_prepay_throttled`).
 *
 * TODO PASA EN EL SERVIDOR. La firma y la llamada a Kapta son PHP: el secreto
 * nunca llega al navegador (es el mismo de los webhooks de pedidos).
 *
 * INSTALACIÓN. Copiar este archivo a `wp-content/mu-plugins/kapta-prepago.php`
 * (los mu-plugins se cargan solos, no se activan) y en `wp-config.php`:
 *
 *   define( 'KAPTA_PREPAY_URL', 'https://<Kapta>/api/webhooks/woocommerce/<id-de-la-tienda>/prepago' );
 *   define( 'KAPTA_PREPAY_SECRET', '<el secreto de los webhooks de WooCommerce que van a Kapta>' );
 *
 * El secreto es EL MISMO de los webhooks de pedidos de WooCommerce que ya
 * apuntan a Kapta (WooCommerce → Ajustes → Avanzado → Webhooks), el mismo que
 * usa COD Core para los formularios abandonados. No hay un secreto nuevo.
 *
 * Sin dependencias. PHP 7.4 o superior.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** Cuánto se espera a Kapta. Más que esto y el checkout sigue sin preguntar. */
if ( ! defined( 'KAPTA_PREPAY_TIMEOUT' ) ) {
	define( 'KAPTA_PREPAY_TIMEOUT', 3 );
}
/** Cuánto se recuerda la respuesta de un celular (10 minutos). */
if ( ! defined( 'KAPTA_PREPAY_CACHE_TTL' ) ) {
	define( 'KAPTA_PREPAY_CACHE_TTL', 10 * MINUTE_IN_SECONDS );
}
/** Si Kapta no contestó, cuánto se deja de preguntar (1 minuto). */
if ( ! defined( 'KAPTA_PREPAY_DOWN_TTL' ) ) {
	define( 'KAPTA_PREPAY_DOWN_TTL', MINUTE_IN_SECONDS );
}
/** Cuántos celulares distintos pregunta un mismo visitante… */
if ( ! defined( 'KAPTA_PREPAY_MAX_PHONES' ) ) {
	define( 'KAPTA_PREPAY_MAX_PHONES', 3 );
}
/** …en este tiempo (10 minutos). */
if ( ! defined( 'KAPTA_PREPAY_THROTTLE_TTL' ) ) {
	define( 'KAPTA_PREPAY_THROTTLE_TTL', 10 * MINUTE_IN_SECONDS );
}
/** El mensaje que ve la clienta si intenta pagar contra entrega igual. */
if ( ! defined( 'KAPTA_PREPAY_MESSAGE' ) ) {
	define(
		'KAPTA_PREPAY_MESSAGE',
		'Para este número el pago contra entrega no está disponible: paga el total en línea (tarjeta o Yape) para completar tu pedido.'
	);
}

/**
 * El celular como lo compara Kapta: solo dígitos y, a un móvil de 9 dígitos que
 * empieza por 9, el 51 delante. Kapta lo vuelve a normalizar; esto solo sirve
 * para que la caché no guarde dos veces el mismo número escrito distinto.
 */
function kapta_prepay_normalize_phone( $raw ) {
	$digits = preg_replace( '/\D+/', '', (string) $raw );
	$digits = preg_replace( '/^00+/', '', $digits );
	if ( strlen( $digits ) === 9 && $digits[0] === '9' ) {
		$digits = '51' . $digits;
	}
	return $digits;
}

/**
 * La llave corta (y salada con el secreto) de un celular: para la caché y para
 * el freno. Un hash sin sal de un móvil de 9 dígitos se revierte en segundos.
 */
function kapta_prepay_phone_hash( $phone ) {
	return substr( hash( 'sha256', $phone . '|' . KAPTA_PREPAY_SECRET ), 0, 32 );
}

/**
 * EL FRENO A QUIEN PRUEBA NÚMEROS. Esconder `cod` le dice a quien mira si un
 * celular está en la lista (quién rechazó un pedido): es un dato personal que
 * Kapta nunca devuelve. Cualquiera puede pedir el recálculo del checkout con
 * otro `billing_phone`, así que por visitante (la sesión de WooCommerce, o su
 * IP) se preguntan como mucho `KAPTA_PREPAY_MAX_PHONES` celulares distintos en
 * `KAPTA_PREPAY_THROTTLE_TTL`. Pasado eso no se pregunta más y el checkout
 * sigue como siempre (falla abierto: Kapta lo frena igual en «Por confirmar» y
 * en la guía). Un celular que ya preguntó ese visitante sigue contando como uno.
 * `true` si este celular ya no se puede preguntar.
 */
function kapta_prepay_throttled( $phone_hash ) {
	$visitor = '';
	if ( function_exists( 'WC' ) && WC()->session && method_exists( WC()->session, 'get_customer_id' ) ) {
		$visitor = (string) WC()->session->get_customer_id();
	}
	if ( $visitor === '' ) {
		$visitor = isset( $_SERVER['REMOTE_ADDR'] ) ? (string) $_SERVER['REMOTE_ADDR'] : 'anon'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
	}
	$key  = 'kapta_prepay_t_' . substr( hash( 'sha256', $visitor . '|' . KAPTA_PREPAY_SECRET ), 0, 32 );
	$seen = get_transient( $key );
	$seen = is_array( $seen ) ? $seen : array();
	if ( in_array( $phone_hash, $seen, true ) ) {
		return false;
	}
	if ( count( $seen ) >= KAPTA_PREPAY_MAX_PHONES ) {
		return true;
	}
	$seen[] = $phone_hash;
	set_transient( $key, $seen, KAPTA_PREPAY_THROTTLE_TTL );
	return false;
}

/**
 * ¿Kapta dice que este celular paga por adelantado? `true` solo si Kapta lo
 * dijo. Cualquier otra cosa (sin configurar, sin celular, error, demora, otra
 * respuesta, el freno de arriba) es `false`: falla abierto.
 *
 * UNA PREGUNTA POR CELULAR Y POR PEDIDO DE PÁGINA. WooCommerce pide los métodos
 * de pago varias veces en un mismo «Realizar pedido» (validar, crear el pedido,
 * cobrarlo) y la validación lo vuelve a mirar: sin el `$memo`, con Kapta lento
 * cada una esperaba los 3 s. Y SI KAPTA NO CONTESTA, se deja de preguntar un
 * minuto (`kapta_prepay_down`) en vez de que cada visita espere 3 s más.
 */
function kapta_prepay_required( $raw_phone ) {
	static $memo = array();
	if ( ! defined( 'KAPTA_PREPAY_URL' ) || ! defined( 'KAPTA_PREPAY_SECRET' ) || ! KAPTA_PREPAY_URL || ! KAPTA_PREPAY_SECRET ) {
		return false;
	}
	$phone = kapta_prepay_normalize_phone( $raw_phone );
	if ( strlen( $phone ) < 9 ) {
		return false;
	}
	if ( array_key_exists( $phone, $memo ) ) {
		return $memo[ $phone ];
	}
	$hash = kapta_prepay_phone_hash( $phone );
	if ( kapta_prepay_throttled( $hash ) ) {
		return $memo[ $phone ] = false;
	}

	// La caché va por un hash salado del celular, no por el número: en la tabla
	// de opciones no queda la lista de quién está en la lista negra.
	$key    = 'kapta_prepay_' . $hash;
	$cached = get_transient( $key );
	if ( $cached === 'si' ) {
		return $memo[ $phone ] = true;
	}
	if ( $cached === 'no' ) {
		return $memo[ $phone ] = false;
	}
	if ( get_transient( 'kapta_prepay_down' ) ) {
		return $memo[ $phone ] = false; // Kapta no contestó hace poco: no se espera otra vez.
	}

	$timestamp = time();
	// El sello va DENTRO del cuerpo firmado y se repite en la cabecera: así una
	// respuesta capturada no sirve para siempre (Kapta rechaza más de 5 minutos).
	$body      = wp_json_encode( array( 'phone' => $phone, 'timestamp' => $timestamp ) );
	$signature = base64_encode( hash_hmac( 'sha256', $body, KAPTA_PREPAY_SECRET, true ) );

	$response = wp_remote_post(
		KAPTA_PREPAY_URL,
		array(
			'timeout'     => KAPTA_PREPAY_TIMEOUT,
			'redirection' => 0,
			'headers'     => array(
				'Content-Type'      => 'application/json',
				'X-Kapta-Signature' => $signature,
				'X-Kapta-Timestamp' => (string) $timestamp,
			),
			'body'        => $body,
		)
	);

	if ( is_wp_error( $response ) || (int) wp_remote_retrieve_response_code( $response ) !== 200 ) {
		// Falla abierto. La respuesta del celular NO se guarda (la próxima vez se
		// vuelve a preguntar), pero se deja de preguntar a Kapta un minuto.
		set_transient( 'kapta_prepay_down', 1, KAPTA_PREPAY_DOWN_TTL );
		return $memo[ $phone ] = false;
	}
	$data = json_decode( wp_remote_retrieve_body( $response ), true );
	if ( ! is_array( $data ) || ! array_key_exists( 'prepay_required', $data ) ) {
		set_transient( 'kapta_prepay_down', 1, KAPTA_PREPAY_DOWN_TTL );
		return $memo[ $phone ] = false;
	}
	$required = ( $data['prepay_required'] === true );
	set_transient( $key, $required ? 'si' : 'no', KAPTA_PREPAY_CACHE_TTL );
	return $memo[ $phone ] = $required;
}

/**
 * El celular de facturación que está escribiendo la clienta. Al recalcular el
 * checkout (`update_order_review`) WooCommerce manda el formulario entero en
 * `post_data`; al pagar, en `billing_phone`. Si no, el del cliente.
 */
function kapta_prepay_current_phone() {
	// phpcs:disable WordPress.Security.NonceVerification.Missing -- WooCommerce ya validó el nonce del checkout.
	if ( isset( $_POST['billing_phone'] ) ) {
		return sanitize_text_field( wp_unslash( $_POST['billing_phone'] ) );
	}
	if ( isset( $_POST['post_data'] ) ) {
		$fields = array();
		parse_str( wp_unslash( $_POST['post_data'] ), $fields );
		if ( ! empty( $fields['billing_phone'] ) ) {
			return sanitize_text_field( $fields['billing_phone'] );
		}
	}
	// phpcs:enable
	if ( function_exists( 'WC' ) && WC()->customer ) {
		return (string) WC()->customer->get_billing_phone();
	}
	return '';
}

/** 1) Sin «Pago contra entrega» para un celular de la lista. */
add_filter(
	'woocommerce_available_payment_gateways',
	function ( $gateways ) {
		if ( is_admin() && ! wp_doing_ajax() ) {
			return $gateways; // wp-admin: no se toca.
		}
		if ( ! isset( $gateways['cod'] ) ) {
			return $gateways;
		}
		if ( ! ( function_exists( 'is_checkout' ) && is_checkout() ) && ! wp_doing_ajax() ) {
			return $gateways; // Solo en el checkout (y su recálculo por AJAX).
		}
		if ( function_exists( 'WC' ) && WC()->cart && WC()->cart->is_empty() ) {
			return $gateways; // Sin carrito no hay nada que pagar: no se pregunta.
		}
		$phone = kapta_prepay_current_phone();
		if ( $phone !== '' && kapta_prepay_required( $phone ) ) {
			unset( $gateways['cod'] );
		}
		return $gateways;
	},
	100
);

/** 2) Al pagar: `cod` con un celular de la lista se rechaza, con mensaje. */
add_action(
	'woocommerce_after_checkout_validation',
	function ( $data, $errors ) {
		if ( ! isset( $data['payment_method'] ) || $data['payment_method'] !== 'cod' ) {
			return;
		}
		$phone = isset( $data['billing_phone'] ) ? (string) $data['billing_phone'] : '';
		if ( $phone !== '' && kapta_prepay_required( $phone ) ) {
			$errors->add( 'kapta_prepago', KAPTA_PREPAY_MESSAGE );
		}
	},
	10,
	2
);

/**
 * 2b) Lo mismo para el checkout de bloques (Store API), si la tienda lo usa. Sin
 * la clase de la Store API, no hace nada.
 */
add_action(
	'woocommerce_store_api_checkout_update_order_from_request',
	function ( $order, $request ) {
		if ( ! class_exists( '\Automattic\WooCommerce\StoreApi\Exceptions\RouteException' ) ) {
			return;
		}
		$method = is_object( $request ) && method_exists( $request, 'get_param' ) ? (string) $request->get_param( 'payment_method' ) : '';
		if ( $method !== 'cod' ) {
			return;
		}
		$phone = is_object( $order ) && method_exists( $order, 'get_billing_phone' ) ? (string) $order->get_billing_phone() : '';
		if ( $phone !== '' && kapta_prepay_required( $phone ) ) {
			throw new \Automattic\WooCommerce\StoreApi\Exceptions\RouteException( 'kapta_prepago', KAPTA_PREPAY_MESSAGE, 400 );
		}
	},
	10,
	2
);

/** 3) Cuando cambia el celular, que WooCommerce vuelva a calcular los métodos de pago. */
add_action(
	'wp_footer',
	function () {
		if ( ! function_exists( 'is_checkout' ) || ! is_checkout() || ( function_exists( 'is_wc_endpoint_url' ) && is_wc_endpoint_url() ) ) {
			return;
		}
		?>
		<script>
		( function ( $ ) {
			if ( ! $ ) { return; }
			var ultimo = null;
			$( document.body ).on( 'change blur', '#billing_phone', function () {
				var valor = ( $( this ).val() || '' ).replace( /\D+/g, '' );
				if ( valor === ultimo ) { return; }
				ultimo = valor;
				$( document.body ).trigger( 'update_checkout' );
			} );
		} )( window.jQuery );
		</script>
		<?php
	}
);
