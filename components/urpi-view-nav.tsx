import Link from "next/link";

/** Las dos caras de Urpi: lo que se le envió y lo que reportó. */
export function UrpiViewNav({ active }: { active: "programaciones" | "resultados" }) {
  const tab = (key: typeof active, href: string, label: string) => (
    <Link href={href} aria-current={active === key ? "page" : undefined}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium ${active === key ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:text-slate-900"}`}>
      {label}
    </Link>
  );
  return <nav aria-label="Urpi" className="inline-flex gap-1 rounded-xl bg-slate-100 p-1">
    {tab("programaciones", "/dashboard/urpi", "Programaciones enviadas")}
    {tab("resultados", "/dashboard/urpi?vista=resultados", "Resultados de entrega")}
  </nav>;
}
