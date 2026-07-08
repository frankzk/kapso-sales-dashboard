# Onboarding de un dueño externo (tenant aislado) + validación

Guía para dar de alta a **otro dueño de tienda** (un amigo, un cliente) de forma
que use el panel con **su propia data, aislada** de tus tiendas (Aurela, Kenku).
El aislamiento ya está garantizado por RLS + credenciales cifradas por tienda +
secreto de webhook por tienda; esta guía es el paso a paso operativo.

> Modelo mental: **cada dueño = su propia `organization`**. El dueño es `owner`
> de su org, conecta sus tiendas, y RLS hace que solo vea lo suyo. **No** lo
> agregues por *Equipo → invitar*: eso lo mete en TU organización y vería tus
> tiendas. Debe registrarse como usuario nuevo y crear su propia org.

---

## 0. Prerequisitos (una sola vez, tú como operador)

1. **Migración aplicada** — `stores.kapso_webhook_secret_enc` debe existir
   (migración `0033`). Verifica en Supabase → SQL Editor:
   ```sql
   select 1 from information_schema.columns
   where table_name='stores' and column_name='kapso_webhook_secret_enc';
   ```
   (Ya aplicada.)

2. **Deploy del código** que incluye el webhook por tienda + el botón "Generar
   secreto" (rama `claude/multi-tenant-subscriptions-tvfj94`). Sin este deploy,
   producción sigue con el webhook viejo y sin el botón. Es 100% compatible con
   lo actual (no rompe Aurela/Kenku).

3. **Registros habilitados en Supabase** para que el amigo pueda crear su cuenta:
   Supabase → **Authentication → Providers/Settings** → activa **"Allow new users
   to sign up"** y asegúrate de que **Google** esté configurado (o el magic link
   por correo). Puedes volver a desactivar los registros después de que se
   registre: su cuenta ya existente sigue funcionando.

---

## 1. El amigo crea su cuenta y su organización

1. Le pasas la URL del panel. Entra en **/login** e inicia sesión con **Google**
   (lo más rápido) o con **magic link** a su correo.
2. Al entrar sin tiendas ve *"Aún no tienes tiendas conectadas"* →
   **Conectar tu primera tienda**.
3. Como no tiene organización, primero crea la suya (queda como **owner**). Esta
   org es exclusivamente suya.

## 2. El amigo (o tú, con él) conecta su tienda

En **Conectar tienda**, con las credenciales **de él**:

- **Dominio Shopify** (`sutienda.myshopify.com`)
- **Shopify Admin API token** y **Shopify API secret** (para el HMAC de webhooks)
- **Kapso API key**, **Kapso project id**, **WhatsApp phone number id**

Al guardar: las credenciales se cifran (AES-GCM), se registran los webhooks de
Shopify (`orders/create`, `orders/updated`) y arranca un backfill inicial.

## 3. Asegurar el webhook de Kapso (aislado, sin tu CRON_SECRET)

En **Ajustes de la tienda → sección "Webhooks de Kapso"**:

1. Clic en **Generar secreto**. Se muestra **una sola vez** el secreto y la
   **URL lista para pegar** (`.../api/webhooks/kapso/<storeId>?secret=<...>`).
   Cópiala.
2. En **Kapso**, pega esa URL en **los dos** webhooks de esa tienda:
   - **WhatsApp webhook** → marca *Conversation ended* + *Conversation inactive*
     (deja el *signing secret* en blanco).
   - **Platform webhook** → marca *workflow.execution.handoff*.
3. (Opcional) Si usa Shopify Flow (búsquedas abandonadas), define también su
   *Secreto webhook de Shopify Flow* en Ajustes.

> Como esta tienda ya tiene su propio secreto, el `CRON_SECRET` compartido **deja
> de funcionar para ella**. Nadie más puede inyectarle leads.

---

## 4. Validación del aislamiento (lo importante)

Comprueba que la data **no se cruza**:

- [ ] **El amigo solo ve lo suyo.** Con su sesión, el dashboard consolidado y el
      selector de tiendas muestran únicamente su(s) tienda(s), nunca Aurela/Kenku.
- [ ] **Tú no ves lo suyo.** Con tu sesión (sin ser miembro de su org), su tienda
      no aparece. Si abres a mano `/dashboard/<idDeSuTienda>` → vacío/sin permiso.
- [ ] **Webhook aislado — su secreto entra.** En el navegador:
      `GET .../api/webhooks/kapso/<suStore>?secret=<suSecreto>` → `{"ok":true}`.
- [ ] **Webhook aislado — el compartido ya no.**
      `GET .../api/webhooks/kapso/<suStore>?secret=<CRON_SECRET>` → **401**.
- [ ] **Su secreto no sirve en otra tienda.**
      `GET .../api/webhooks/kapso/<storeDeAurela>?secret=<suSecreto>` → **401**.
- [ ] **Un lead real cae solo en su panel.** Genera un handoff/orden de prueba en
      su Kapso/Shopify → aparece en su dashboard y **no** en el tuyo.

Si los seis pasan, el tenant está correctamente aislado. ✅

---

## Notas

- **Rotar el secreto**: *Regenerar secreto* en Ajustes invalida el anterior;
  hay que volver a pegar la URL nueva en los dos webhooks de Kapso.
- **Roles dentro de la org del amigo**: si él quiere sumar vendedoras/asesoras,
  usa *Equipo* **dentro de su propia org** (eso sí es correcto: quedan en SU org).
- Este runbook cubre el aislamiento. El **cobro de la suscripción** (billing,
  planes, límites) es el siguiente bloque, aún no implementado.
