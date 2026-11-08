/**
 * A voucher can be pasted anywhere, but must not consume text meant for an
 * editor (Maps sometimes puts both text and an image on the clipboard).
 * Local paste handlers, such as the conversation composer, take precedence.
 */
export function globalPasteImage(event: ClipboardEvent): File | null {
  if (event.defaultPrevented) return null;
  const target = event.target instanceof Element ? event.target : null;
  const editor = target?.closest("input, textarea, [contenteditable]:not([contenteditable='false']), [role='textbox']");
  if (editor && event.clipboardData?.getData("text/plain").trim()) return null;

  const image = Array.from(event.clipboardData?.items ?? []).find((item) => item.type.startsWith("image/"));
  return image?.getAsFile() ?? null;
}
