import type { LimaPendingOrder } from "@/lib/repro-lima-pending";

export type LimaPackageLocation = "warehouse" | "courier" | "returning" | "unknown";

/** Solo custodia registrada: ni guía, ni asignación, ni fecha prueban ubicación. */
export function limaPackageLocation(row: LimaPendingOrder): LimaPackageLocation {
  switch (row.ops?.custody) {
    case "empresa": case "devuelto": return "warehouse";
    case "courier": return "courier";
    case "retorno": return "returning";
    default: return "unknown";
  }
}
