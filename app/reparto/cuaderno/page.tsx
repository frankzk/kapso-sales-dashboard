import { redirect } from "next/navigation";

/**
 * Hubo dos pantallas del motorizado (MOM §29.12). Queda una: /reparto, donde
 * la parada es la verdad y el cuaderno es su vocabulario. Los enlaces viejos
 * llegan aquí y siguen.
 */
export default function CuadernoRedirect() {
  redirect("/reparto");
}
