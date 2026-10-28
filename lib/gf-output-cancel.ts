/** Solo una salida interna que nunca salió. El RPC comprueba además caja y parada. */
export function gfOutputIsCancelableBeforeDispatch(s: {
  courier: string; created_via?: string | null; delivery_status: string;
  custody_state?: string | null; custody_transferred_at?: string | null;
  dispatched_at?: string | null; returned_at?: string | null; reported_status?: string | null;
}): boolean {
  return s.created_via === "grupo_gf_courier" && s.courier === "propio" &&
    s.delivery_status === "pendiente" && s.custody_state === "empresa" &&
    !s.custody_transferred_at && !s.dispatched_at && !s.returned_at && !s.reported_status;
}
