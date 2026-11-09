import { redirect } from "next/navigation";
import { PREPAY_LIST_PATH } from "@/lib/prepay-list";

// La ruta de antes de la «Lista negra» unificada (owner, 09-11-2026): los
// enlaces guardados siguen llegando a la página nueva.
export default function PagoAdelantadoRedirect() {
  redirect(PREPAY_LIST_PATH);
}
