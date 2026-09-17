// Donde vuelve la clienta después de pagar por Flow.cl (`urlReturn`).
//
// PÚBLICA A PROPÓSITO. Quien llega aquí acaba de pagar desde su celular y no
// tiene cuenta en el dashboard; `proxy.ts` solo protege `/dashboard`.
//
// NO DICE SI EL PAGO SALIÓ BIEN, y es deliberado: Flow manda aquí al pagador
// con un POST que no viene firmado, y lo único que confirma un pago es
// `payment/getStatus`, que se consulta desde el webhook. Afirmar «pago
// confirmado» en esta página sería creerle a una redirección. Se le dice lo
// que sí es cierto: que el comprobante llega solo y que no hace falta que
// mande nada por WhatsApp.

export const dynamic = "force-dynamic";

export default function GraciasPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6 py-12 text-slate-800">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-4xl">🧾</p>
        <h1 className="mt-3 text-xl font-semibold">Listo, recibimos tu operación</h1>
        <p className="mt-3 text-sm text-slate-600">
          En cuanto el banco nos confirme el pago, tu pedido se actualiza solo.{" "}
          <strong>No hace falta que mandes la constancia por WhatsApp.</strong>
        </p>
        <p className="mt-3 text-sm text-slate-600">
          Si pagaste el saldo de un envío, tu clave de recojo te llega por el mismo chat cuando el
          cobro quede validado.
        </p>
        <p className="mt-4 text-xs text-slate-400">
          Puedes cerrar esta ventana y volver a WhatsApp.
        </p>
      </div>
    </main>
  );
}
