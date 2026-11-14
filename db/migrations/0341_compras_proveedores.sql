-- ============================================================================
-- 0341_compras_proveedores.sql — «Compras»: la página de proveedores (MOM §45.7,
-- 14-11-2026). Fase 4 de docs/compras/referencia-modulo-compras.md §11.
--
-- QUÉ CAMBIA. Tres columnas opcionales en `import_suppliers` (0340), las que la
-- referencia (§4.3, §5.7) muestra en la tabla de proveedores:
--   * `contact_name`:  la persona de contacto (hasta 120 caracteres).
--   * `email`:         el correo (hasta 160, con forma `algo@dominio.tld`).
--   * `payment_terms`: las condiciones de pago («30 % adelanto, 70 % al
--                      embarque»; hasta 200).
--
-- QUIÉN LEE Y ESCRIBE. Igual que en la 0340: solo el servidor (service_role),
-- después de comprobar el permiso. La tabla ya tiene RLS encendida, sin
-- políticas y sin privilegios para anon ni authenticated; las columnas nuevas
-- heredan eso. Se repite el revoke/grant para que quede escrito aquí también.
--
-- Solo agrega columnas nulas: no cambia datos existentes y no usa `drop`
-- (DEPLOY.md, 0248). Correrla otra vez no cambia nada (`if not exists`).
-- ============================================================================

alter table public.import_suppliers
  add column if not exists contact_name text
    constraint import_suppliers_contact_name_len
    check (contact_name is null or char_length(btrim(contact_name)) between 1 and 120);

alter table public.import_suppliers
  add column if not exists email text
    constraint import_suppliers_email_shape
    check (email is null or (char_length(email) <= 160 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));

alter table public.import_suppliers
  add column if not exists payment_terms text
    constraint import_suppliers_payment_terms_len
    check (payment_terms is null or char_length(btrim(payment_terms)) between 1 and 200);

comment on column public.import_suppliers.contact_name is
  'Compras (MOM §45.7): persona de contacto del proveedor. Opcional.';
comment on column public.import_suppliers.email is
  'Compras (MOM §45.7): correo del proveedor. Opcional.';
comment on column public.import_suppliers.payment_terms is
  'Compras (MOM §45.7): condiciones de pago del proveedor. Opcional.';

-- ── Solo el servidor (como en la 0340) ─────────────────────────────────────
alter table public.import_suppliers enable row level security;
revoke all on public.import_suppliers from anon, authenticated;
grant all privileges on public.import_suppliers to service_role;
