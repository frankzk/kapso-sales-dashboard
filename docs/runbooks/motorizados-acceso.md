# Acceso de motorizados: usuario y contraseña

Runbook para dar de alta, cambiar la contraseña, desatar, desactivar o
reactivar el acceso de un motorizado. Está pensado para ejecutarse desde un
agente de IA en el repositorio: cada operación es un comando, con su
comprobación y su marcha atrás. Las contraseñas **no se guardan en ningún
sitio**: el comando las imprime una vez y quien lo ejecuta se las entrega al
motorizado en mano.

## Cómo funciona (lo mínimo para no romperlo)

- Un motorizado es una **ficha** en `riders` (Liquidaciones → Motorizados) y,
  si reparte con la app, un **usuario** de Supabase Auth atado por
  `riders.user_id`. La ficha existe aunque no tenga usuario (0064, 0066).
- Supabase Auth identifica a cada persona por correo y muchos motorizados no
  tienen uno. Se les da un **usuario corto** (`roy`) que el sistema convierte
  en `roy@motorizados.kapta.local`: un correo sintético, no enrutable, que
  nunca recibe nada. La conversión vive en `lib/rider-auth.ts`
  (`riderUsernameToEmail`, con pruebas en `test/rider-auth.test.ts`). Si el
  motorizado tiene Gmail, también puede tener su correo real como usuario y
  entrar con Google: son dos puertas al mismo usuario solo si el correo
  coincide.
- El usuario recibe una **membresía** con rol `motorizado` en la organización
  de la ficha. Ese rol solo concede `routes.deliver`; la RLS de 0171
  (`auth_is_rider_only()`) acota sus lecturas a su hoja cuando ese es su único
  rol. **Un motorizado no debe tener ningún otro rol**: el script lo rechaza.
- En `/login` hay un enlace discreto «Entrar con usuario y contraseña»
  (`components/auth-form.tsx`, `signInWithPassword`). Al entrar, `proxy.ts`
  manda a un usuario solo motorizado a `/reparto`, y le cierra el resto del
  panel.
- Requisito en el panel de Supabase (Authentication → Providers → Email):
  proveedor Email activado. Los usuarios se crean con `email_confirm: true`,
  así que no importa si «Confirm email» está activo y no se envía ningún
  correo. No hace falta tocar «Site URL» ni redirecciones: el login con
  contraseña no redirige por correo.
- Todo se hace con la clave de servicio: el script lee `.env.local` y `.env`
  (`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). Corre desde la
  raíz del repo con `pnpm tsx scripts/rider-user.ts …`.

## Operaciones

Todas con `pnpm tsx scripts/rider-user.ts <comando>`. `<usuario>` es el nombre
corto (`roy`) o un correo completo. `<nombre-ficha>` es el `full_name` de la
ficha, sin distinguir mayúsculas; si hay dos fichas con el mismo nombre en
organizaciones distintas, añade `--org <org_id>`.

| Quiero…                                   | Comando                                        | Qué hace |
|-------------------------------------------|------------------------------------------------|----------|
| Dar acceso a un motorizado nuevo          | `create <nombre-ficha> [--usuario roy] [--org …]` | Crea el usuario Auth con contraseña aleatoria (10 caracteres legibles, sin 0/O/1/l/I), la membresía `motorizado` y ata la ficha. Si la ficha estaba atada a otro usuario (p. ej. el owner en pruebas), la desata y la ata al nuevo. Imprime usuario y contraseña una sola vez. Sin `--usuario`, deriva el usuario del nombre de la ficha. |
| Se olvidó la contraseña                   | `reset-password <usuario>`                     | Genera una nueva y la imprime. La anterior deja de valer al instante. |
| Ponerle una contraseña concreta           | `set-password <usuario> <clave>`               | Mínimo 6 caracteres. Úsalo solo si el motorizado pide una que recuerde; la aleatoria es preferible. |
| Ya no reparte (baja)                      | `disable <usuario>`                            | Lo bloquea en Auth (`ban_duration` largo). No borra nada: su historial de rutas, hojas y liquidaciones queda intacto. La ficha sigue atada. |
| Vuelve a repartir                         | `enable <usuario>`                             | Quita el bloqueo. Conserva su contraseña; si no la recuerda, `reset-password`. |
| Atar una ficha a un usuario que ya existe | `attach <nombre-ficha> <usuario>`              | Para cuando el usuario se creó por Google o enlace mágico. Crea la membresía `motorizado` si falta. |
| Desatar la ficha de su usuario            | `detach <nombre-ficha>`                        | Deja `riders.user_id` en null. El usuario sigue existiendo (desactívalo con `disable` si ya no reparte). |
| Ver el estado de todos                    | `list`                                         | Ficha, activa, courier, usuario, roles y si está desactivado. |

Ejemplo completo de alta (lo que se hizo con Roy el 19-09-2026):

```bash
pnpm tsx scripts/rider-user.ts create Roy --usuario roy --org 7c4cb666-f6b5-432e-822d-fee06b61821b
# ✔ Ficha «Roy» atada al usuario roy@motorizados.kapta.local (…); membresía motorizado creada.
#   USUARIO:    roy
#   CONTRASEÑA: ……   (una sola vez)
```

## Comprobar

1. `pnpm tsx scripts/rider-user.ts list` debe mostrar la ficha con su usuario,
   rol `motorizado` (y solo ese) y estado `activo`.
2. En base (sustituye el nombre):

   ```sql
   select r.full_name, r.user_id, u.email, u.email_confirmed_at is not null as confirmado, u.banned_until
     from riders r join auth.users u on u.id = r.user_id where r.full_name = 'Roy';
   select role, org_id from memberships where user_id = '<user_id>';
   ```

   Esperado: un correo `…@motorizados.kapta.local`, `confirmado = t`,
   `banned_until` nulo y una única membresía `motorizado`.
3. Prueba de acceso sin abrir el navegador (clave anónima, no la de servicio):

   ```bash
   curl -s -X POST "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/token?grant_type=password" \
     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
     -d '{"email":"roy@motorizados.kapta.local","password":"<clave>"}'
   ```

   Si devuelve `access_token`, el motorizado puede entrar. En la app: `/login`
   → «Entrar con usuario y contraseña» → debe aterrizar en `/reparto`.

## Deshacer

- Alta equivocada: `detach <ficha>` y luego `disable <usuario>`. No se borran
  usuarios desde el script: si de verdad hay que eliminarlo (recién creado, sin
  historial), hazlo desde el panel de Supabase → Authentication → Users.
- Ficha atada al usuario equivocado: `attach <ficha> <usuario-correcto>`.
- Contraseña filtrada: `reset-password <usuario>`; la anterior queda inválida
  al momento.

## Errores que devuelve el script y qué significan

- «No existe la ficha de motorizado»: crea primero la ficha en Liquidaciones →
  Motorizados (o revisa el nombre exacto con `list`).
- «El usuario ya es «owner» en esa organización»: intentaste atar un motorizado
  a un usuario del equipo. Un motorizado necesita su propio usuario; usa
  `create` con otro `--usuario`.
- «Usuario no válido»: solo letras, números, punto, guion o guion bajo, entre
  2 y 31 caracteres, o un correo completo.

## Lo que ve el motorizado si falla

Los mensajes del formulario salen de `friendlyPasswordError` en
`lib/rider-auth.ts`: «Usuario o contraseña incorrectos», «Tu usuario está
desactivado», «Demasiados intentos». Si dice «todavía no está activado», el
usuario se creó sin `email_confirm`; arréglalo con `set-password` (no
confirma) o desde el panel de Supabase marcando el correo como confirmado.
