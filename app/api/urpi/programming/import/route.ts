import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { readUrpiExcelWorkbook } from "@/lib/urpi-excel";
import { importUrpiBook, openUrpiBook } from "@/lib/urpi-programming-import";

export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const startedAt = new Date().toISOString();
  try {
    // Reject oversized request before multipart parsing, including multipart overhead.
    if (Number(request.headers.get("content-length")) > MAX_BYTES + 65536) return NextResponse.json({ error: "El archivo supera 8 MB." }, { status: 413 });
    const form = await request.formData();
    const book = await openUrpiBook(String(form.get("sourceId") ?? "")).catch((error: unknown) => error instanceof Error ? error : new Error("Archivo no encontrado o sin acceso."));
    if (book instanceof Error) return NextResponse.json({ error: book.message }, { status: 403 });
    const file = form.get("file");
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".xlsx")) return NextResponse.json({ error: "Carga el libro mensual completo en formato .xlsx." }, { status: 400 });
    if (!file.size || file.size > MAX_BYTES) return NextResponse.json({ error: "El archivo debe pesar entre 1 byte y 8 MB." }, { status: 413 });
    const workbook = await readUrpiExcelWorkbook(await file.arrayBuffer());
    // Un Excel de un libro mixto se reparte entre todas sus tiendas registradas.
    const result = await importUrpiBook(book, workbook, { startedAt, origin: "excel", filename: file.name.slice(0, 200) });
    if (result.saved) revalidatePath("/dashboard/urpi");
    return NextResponse.json(result.ok ? { ok: true, message: result.message, saved: result.saved } : { error: result.message, saved: result.saved }, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "No se pudo importar el archivo." }, { status: 400 });
  }
}
