// Descarga un PDF de rótulos sin abrir otra pestaña (Master y ficha del pedido).
//
// Es un fetch y no una navegación: si el endpoint responde un error —pedidos
// sin salida, por ejemplo— esa respuesta es JSON y se devuelve como mensaje en
// vez de descargarse. Solo para el navegador.

export async function downloadPdf(
  url: string,
  missingHeader: string,
  fallbackName: string,
): Promise<{ error?: string; missing: number; failed: number }> {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    return { error: body?.error ?? "No se pudieron generar los rótulos.", missing: 0, failed: 0 };
  }
  const missing = Number(response.headers.get(missingHeader) ?? "0");
  const failed = Number(response.headers.get("x-combinadas-fallidas") ?? "0");
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download =
    response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
  return { missing, failed };
}
