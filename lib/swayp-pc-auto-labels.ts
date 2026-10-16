// Los textos del Swayp automático desde Por confirmar (MOM §11.13), sin
// dependencias: los lee el panel, que es un componente de cliente, y no puede
// arrastrar módulos de servidor al navegador.

/** El brazo del piloto. `swayp` sale solo; `control` sigue la cola de llamadas. */
export type PcAutoArm = "swayp" | "control";

export const PC_AUTO_ARM_LABEL: Record<PcAutoArm, string> = {
  swayp: "A · Sale por Swayp",
  control: "B · Sigue las llamadas",
};

export const PC_AUTO_REASONS: Record<string, string> = {
  eligible: "Cumple los criterios",
  stage: "No está por confirmar (o está en «Swayp no entregó», «Volver a contactar» o «Pendiente de abono»)",
  not_provincia_cod: "No es provincia contra entrega",
  not_swayp_ok: "Swayp no lo lleva hoy (cobertura o stock)",
  old_order: "Pedido con más horas que el límite",
  invalid_order: "Pedido anulado, reembolsado o con cobro por revisar",
  no_attempt: "Todavía sin llamada",
  too_many_unanswered: "Demasiadas llamadas sin respuesta",
  scheduled: "Tiene fecha para volver a contactar",
  address: "Dirección sin número ni manzana y lote",
  agency: "Pide recojo en agencia",
  phone: "Teléfono inválido",
  amount: "Importe mayor que el límite del piloto",
  payment: "Tiene un pago registrado",
  live_output: "Ya tiene otra salida viva",
  rejection: "Ese teléfono rechazó, negó la compra o fue descartado antes",
  duplicate: "Otro pedido vivo o reciente del mismo teléfono con el mismo producto",
  same_product: "Productos sin SKU o sin cantidad",
  // Las del servidor
  control: "Grupo de control: sigue la cola de llamadas",
  location: "El pin del GPS no corresponde al distrito de la dirección",
  no_location: "Sin coordenadas para corroborar la ubicación",
  warehouse_paused: "Bodega con fallas propias en los últimos 7 días",
  no_mapping: "Falta vínculo de algún producto con Swayp",
  no_stock: "Sin stock completo en la bodega Swayp",
  api_disabled: "Bodega sin emisión por API",
  cap_daily: "Cupo diario alcanzado",
  cap_warehouse: "Cupo diario de la bodega alcanzado",
  emission_error: "Swayp no emitió la guía",
  created: "Guía Swayp creada",
};
