"use server";

// Registrar la venta de alguien que NO está en la cola.
//
// EL CASO. A veces el cliente no llegó por WhatsApp: llamó, escribió por otro
// lado, o alguien lo trajo. La venta existe y hoy no se le cuenta a nadie —
// medido: de 1.226 pedidos `venta_manual` en 90 días, 30 no tienen lead con ese
// teléfono, así que su asesor no aparece en Productividad.
//
// POR QUÉ ESTO CREA UN LEAD Y NO UN PEDIDO SUELTO. La acreditación al asesor
// vive en `lead_calls`, cuya columna `lead_id` es NOT NULL. Sin lead no hay a
// quién acreditarle la venta, que es exactamente lo que se venía a arreglar. Y
// creado el lead, el resto del camino es el que ya existe: `generateOrder`, con
// sus validaciones, su etiqueta y su confirmación por WhatsApp. Un formulario
// paralelo garantizaría que dentro de tres meses uno valide el distrito y el
// otro no.

import { createAdminSupabase, createServerSupabase } from "@/lib/db";
import { getAccessibleStores } from "@/lib/access";
import { normalizePhone } from "@/lib/phone";
import { getPedidosRecientesPorTelefono } from "@/lib/leads-access";
import { avisoDuplicado, type AvisoDuplicado } from "@/lib/pedido-duplicado";

export interface ClienteParaVenta {
  ok: boolean;
  error?: string;
  leadId?: string;
  /** ¿El lead ya existía en la cola, o se acaba de crear? */
  existia?: boolean;
  nombre?: string | null;
  aviso?: AvisoDuplicado | null;
}

/**
 * Qué sabemos de este teléfono antes de abrirle un pedido.
 *
 * No escribe nada: solo mira. Es la pantalla previa al formulario, para que el
 * aviso de duplicado salga ANTES de que alguien llene diez campos.
 */
export async function consultarClientePorTelefono(
  storeId: string,
  phone: string,
): Promise<ClienteParaVenta> {
  const stores = await getAccessibleStores();
  if (!stores.some((s) => s.id === storeId)) return { ok: false, error: "Tienda inválida o sin acceso." };

  const tel = normalizePhone(phone);
  if (!tel) return { ok: false, error: "Escribe un celular válido." };

  const sb = await createServerSupabase();
  const { data: lead } = await sb
    .from("leads")
    .select("id,name,status")
    .eq("store_id", storeId)
    .eq("phone", tel)
    .maybeSingle();

  const previos = await getPedidosRecientesPorTelefono(storeId, tel);
  // Todavía no se sabe qué va a pedir, así que el aviso se calcula sin
  // productos: sirve para «ya tiene un pedido abierto» y «ya le entregamos».
  // El de MISMOS productos vuelve a calcularse al confirmar, cuando ya hay
  // líneas — es el momento en que la comparación puede ser cierta.
  const aviso = avisoDuplicado(previos, [], new Date().toISOString());

  const l = lead as { id: string; name: string | null } | null;
  return {
    ok: true,
    leadId: l?.id,
    existia: !!l,
    nombre: l?.name ?? null,
    aviso,
  };
}

/**
 * Abre el cliente para venderle: devuelve su lead, creándolo si no existe.
 *
 * Empareja por `(store_id, phone)`, que es el índice único de `leads`. Buscar
 * primero no es cortesía: insertar a ciegas lo rechazaría la base y el asesor
 * vería un error de índice después de llenar el formulario.
 */
export async function abrirClienteParaVenta(input: {
  storeId: string;
  phone: string;
  nombre?: string | null;
}): Promise<ClienteParaVenta> {
  const previo = await consultarClientePorTelefono(input.storeId, input.phone);
  if (!previo.ok) return previo;
  if (previo.leadId) return previo;

  const tel = normalizePhone(input.phone)!;
  const admin = createAdminSupabase();
  const nowIso = new Date().toISOString();
  const { data, error } = await admin
    .from("leads")
    .insert({
      store_id: input.storeId,
      phone: tel,
      name: input.nombre?.trim() || null,
      status: "nuevo",
      category: "open",
      needs_attention: false,
      // Fuente PROPIA y no null. Null significa «orgánico» en el reparto por
      // fuente, y meter ahí las ventas telefónicas ensuciaría esa métrica sin
      // que nadie lo note. `manual` dice lo que es: alguien lo registró a mano.
      source: "manual",
      first_seen_at: nowIso,
      last_interaction_at: nowIso,
    })
    .select("id")
    .single();
  // Carrera: dos asesores con el mismo cliente a la vez. El índice único evita
  // el duplicado; acá se recupera el que ganó en vez de devolver un error que
  // no le dice nada a quien está con el cliente al teléfono.
  if (error) {
    const { data: existente } = await admin
      .from("leads")
      .select("id,name")
      .eq("store_id", input.storeId)
      .eq("phone", tel)
      .maybeSingle();
    const e = existente as { id: string; name: string | null } | null;
    if (!e) return { ok: false, error: error.message };
    return { ...previo, leadId: e.id, existia: true, nombre: e.name };
  }

  return { ...previo, leadId: (data as { id: string }).id, existia: false };
}
