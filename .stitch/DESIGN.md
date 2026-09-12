# Grupo GF Courier — operaciones móviles

## Fuente y alcance

Sistema semántico adaptado con impeccable (registro product), stitch-design,
stitch-design-taste y ui-ux-pro-max. No existe conexión Stitch en esta sesión:
no se atribuyen pantallas generadas ni un projectId inexistente. El buscador
Python de ui-ux-pro-max apunta a archivos ausentes; se aplica su guía completa.
Esta especificación conserva el diseño de Kapta y sirve para futuras pantallas.

## Atmósfera

Herramienta de trabajo de pie en almacén, luz diurna, una mano y cámara.
Densidad 6/10; variación 2/10; movimiento 1/10. Predictibilidad y velocidad
por encima de decoración. Un control físico pendiente por pantalla.

## Paleta y tipografía

- Azul operativo, brand-600 (#1F5FE0): acción principal; brand-700 (#1B4FBD): enlaces.
- Tinta pizarra, slate-900 (#0F172A): títulos y códigos.
- Texto secundario, slate-600 (#475569): contexto legible.
- Lienzo, slate-50 (#F8FAFC); separadores, slate-200 (#E2E8F0).
- Éxito emerald-800 sobre emerald-50; advertencia amber-800 sobre amber-50;
  error red-700 sobre red-50, siempre con texto, nunca color solo.

Reutilizar tokens Tailwind actuales (neutrales OKLCH); no nueva paleta.
Conservar la sans de la aplicación. Texto de tarea 14–16 px, campos 16 px,
títulos 18–20 px, cifras tabulares. No truncar cliente/distrito del paquete.
El producto actual declara esquema claro: no simular un tema oscuro parcial.

## Componentes y estructura

1. Barra móvil de 56 px: sección actual y botón Menú de 48 px. Navegación
   desplegable en flujo, cierre Escape y enlaces con permisos existentes.
2. Courier: cuatro pestañas cortas, contador bajo etiqueta; condiciones
   del servicio plegadas; cada carga es un bloque de tarea, no una tabla ancha.
3. Caja activa: motorizado, fecha y carga juntos; selector bajo Cambiar de caja.
4. Escanear con cámara es principal; ingreso manual explícito. El lector de
   escritorio conserva foco solo con puntero preciso y capacidad hover.
5. Avance y resultado accesibles; caja completa ofrece recepción, no más
   acciones de escaneo ni transferencia ficticia.
6. Corregir contenido es secundario y separado; conservar motivo e historial.

## Responsive e interacción

375–767 px: columna única, márgenes 16 px, módulos 12–16 px, controles 48 px.
Las listas operativas reordenan los mismos datos/handlers en vertical; tarjetas
de ruta mantienen su acceso principal visible. Escritorio conserva tablas.
Cámara modal con cierre accesible, Escape, foco contenido, máximo 95dvh y
safe-area inferior; cancelar detiene el stream aun si el permiso llega tarde.
Los errores de red liberan el lector y explican cómo reintentar el mismo QR.

## Movimiento y prohibiciones

Solo feedback funcional de color, sin bucles, cascadas o espera decorativa.
Sin carruseles de navegación, scroll horizontal en tareas del teléfono,
autofocus táctil, acciones importantes fuera de vista, paneles negros enormes,
copias repetidas de Roy/carga o botones destructivos junto al escaneo.
Las excepciones a defaults creativos de Stitch Taste son deliberadas: se trata
de operación logística, no una landing ni una vitrina de marca.

## Prompt preparado para Stitch

Mobile web, 390 × 844. Grupo GF Courier, authenticated warehouse operations.
Compact section bar with Menu; four equal short tabs. Show an operational
load for Roy, date and Carga 1, separate assigned/armed/verified/received counts,
and a full-width Verificar caja action. Second screen: office verification,
compact selected-box context, camera-first button, collapsed manual code input,
progress, readable package rows. Finished state says Caja verificada and offers
Continuar a recepción without implying custody transfer. Existing slate/brand
tokens, no gradients or decorative animation; 48px controls, no horizontal scroll.
