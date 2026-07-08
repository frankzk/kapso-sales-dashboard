import Link from "next/link";
import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/db";

export const dynamic = "force-dynamic";

// Public marketing landing. Signed-in users skip straight to the dashboard.
export default async function Home() {
  const sb = await createServerSupabase();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (user) redirect("/dashboard");

  return (
    <div className="min-h-screen scroll-smooth bg-white text-slate-900 [font-feature-settings:'cv11']">
      <Nav />
      <Hero />
      <StatBand />
      <Integrations />
      <ProblemSolution />
      <Bento />
      <DeepDives />
      <Security />
      <HowItWorks />
      <Faq />
      <FinalCta />
      <Footer />
    </div>
  );
}

/* ================================================================== Nav === */
function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-slate-200/60 bg-white/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">Kapso Sales</span>
        </div>
        <nav className="hidden items-center gap-1 md:flex">
          {[
            ["Producto", "#producto"],
            ["Seguridad", "#seguridad"],
            ["Cómo funciona", "#como"],
            ["Preguntas", "#faq"],
          ].map(([label, href]) => (
            <a
              key={label}
              href={href}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:text-slate-900"
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2 sm:gap-3">
          <Link
            href="/login"
            className="hidden rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:text-slate-900 sm:block"
          >
            Iniciar sesión
          </Link>
          <Link
            href="/signup"
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
          >
            Crea tu cuenta
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ================================================================= Hero === */
function Hero() {
  return (
    <section className="relative overflow-hidden">
      <GridGlow />
      <div className="relative z-10 mx-auto max-w-6xl px-5 pt-20 pb-12 text-center sm:pt-28">
        <div className="animate-fade-up">
          <a
            href="#producto"
            className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/70 py-1.5 pr-3 pl-1.5 text-xs font-medium text-slate-600 shadow-sm backdrop-blur transition hover:border-brand-200"
          >
            <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-bold tracking-wide text-white">
              NUEVO
            </span>
            Analítica de ventas para tiendas de WhatsApp
            <ArrowIcon />
          </a>
        </div>

        <h1
          className="mx-auto mt-7 max-w-4xl animate-fade-up text-[2.6rem] leading-[1.02] font-semibold tracking-[-0.03em] text-slate-900 sm:text-[4.25rem]"
          style={{ animationDelay: "60ms" }}
        >
          Todo lo que vendes por WhatsApp,
          <br className="hidden sm:block" />{" "}
          <span className="bg-gradient-to-r from-brand-700 via-brand-500 to-brand-600 bg-clip-text text-transparent">
            medido en una sola pantalla
          </span>
          .
        </h1>

        <p
          className="mx-auto mt-6 max-w-2xl animate-fade-up text-lg leading-relaxed text-slate-600"
          style={{ animationDelay: "120ms" }}
        >
          Kapso Sales conecta tu Shopify y tu bot de WhatsApp y te muestra{" "}
          <strong className="font-semibold text-slate-800">ingresos, conversión, leads y operación</strong>{" "}
          en tiempo real — por tienda y consolidado, con tu data 100% aislada.
        </p>

        <div
          className="mt-9 flex animate-fade-up flex-col items-center justify-center gap-3 sm:flex-row"
          style={{ animationDelay: "180ms" }}
        >
          <Link
            href="/signup"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-brand-600/25 transition hover:bg-brand-700 sm:w-auto"
          >
            Crea tu cuenta gratis
            <ArrowIcon />
          </Link>
          <a
            href="#producto"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 sm:w-auto"
          >
            <PlayIcon /> Ver el producto
          </a>
        </div>

        <p className="mt-4 animate-fade-up text-xs text-slate-400" style={{ animationDelay: "240ms" }}>
          Sin tarjeta · Conectas en 5 minutos · Credenciales cifradas (AES-256)
        </p>
      </div>

      {/* Product shot */}
      <div
        id="producto"
        className="relative z-10 mx-auto max-w-6xl animate-fade-up px-5 pb-4 scroll-mt-20"
        style={{ animationDelay: "300ms" }}
      >
        <AppShot />
      </div>
    </section>
  );
}

function GridGlow() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(15,23,42,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(15,23,42,0.04) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          maskImage: "radial-gradient(70% 55% at 50% 25%, black, transparent 80%)",
          WebkitMaskImage: "radial-gradient(70% 55% at 50% 25%, black, transparent 80%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-32 z-0 mx-auto h-[560px] max-w-4xl animate-sheen blur-3xl"
        style={{
          background:
            "radial-gradient(55% 55% at 50% 30%, rgba(47,116,255,0.30) 0%, rgba(124,58,237,0.12) 45%, rgba(255,255,255,0) 74%)",
        }}
      />
    </>
  );
}

/* ------------------------------------------------- Full app screenshot --- */
function AppShot() {
  return (
    <div className="relative">
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-10 -z-10 rounded-[2.5rem] blur-3xl"
        style={{ background: "radial-gradient(45% 50% at 50% 35%, rgba(47,116,255,0.20), rgba(255,255,255,0))" }}
      />
      <div className="animate-float overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-2xl shadow-slate-900/15 ring-1 ring-slate-900/5">
        {/* chrome */}
        <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5">
          <span className="h-3 w-3 rounded-full bg-slate-300" />
          <span className="h-3 w-3 rounded-full bg-slate-300" />
          <span className="h-3 w-3 rounded-full bg-slate-300" />
          <div className="mx-auto flex items-center gap-1.5 rounded-md bg-white px-3 py-1 text-[11px] text-slate-400 ring-1 ring-slate-200">
            <LockMini /> app.kapsosales.com / dashboard
          </div>
        </div>

        <div className="flex text-left">
          {/* sidebar */}
          <aside className="hidden w-44 shrink-0 border-r border-slate-100 bg-slate-50/40 p-3 md:block">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Logo sm />
              <span className="text-xs font-semibold text-slate-700">Kapso Sales</span>
            </div>
            <nav className="mt-3 space-y-0.5">
              {[
                ["Resumen", true],
                ["Ventas", false],
                ["Conversión", false],
                ["Leads", false],
                ["Atribución Meta", false],
                ["Envíos", false],
              ].map(([label, active]) => (
                <div
                  key={label as string}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] ${
                    active ? "bg-brand-50 font-semibold text-brand-700" : "text-slate-500"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-brand-500" : "bg-slate-300"}`} />
                  {label}
                </div>
              ))}
            </nav>
            <div className="mt-4 rounded-lg border border-slate-200 bg-white p-2.5">
              <p className="text-[10px] font-medium text-slate-400">Tienda</p>
              <p className="mt-0.5 text-[11px] font-semibold text-slate-700">Todas (3)</p>
            </div>
          </aside>

          {/* main */}
          <div className="min-w-0 flex-1 p-4 sm:p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-900">Resumen consolidado</p>
                <p className="text-[11px] text-slate-400">Últimos 30 días · comparado con periodo anterior</p>
              </div>
              <span className="hidden items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-600 sm:inline-flex">
                <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-emerald-500" /> En vivo
              </span>
            </div>

            {/* KPIs */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <ShotKpi label="Ingresos netos" value="S/ 48,290" delta="+12%" />
              <ShotKpi label="Órdenes" value="312" delta="+8%" />
              <ShotKpi label="AOV" value="S/ 154" delta="+3%" />
              <ShotKpi label="Conv. chat→venta" value="24%" delta="+3pts" />
            </div>

            {/* chart + sources */}
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-white p-3.5 lg:col-span-2">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold text-slate-700">Ingresos por día</p>
                  <div className="flex items-center gap-2 text-[10px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-brand-500" /> Este mes
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-slate-300" /> Anterior
                    </span>
                  </div>
                </div>
                <AreaChart />
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3.5">
                <p className="mb-3 text-xs font-semibold text-slate-700">Origen de ventas</p>
                <SourceBars />
              </div>
            </div>

            {/* funnel + leads */}
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-white p-3.5">
                <p className="mb-3 text-xs font-semibold text-slate-700">Embudo conversación → venta</p>
                <Funnel />
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3.5">
                <div className="mb-3 flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-emerald-500" />
                  <p className="text-xs font-semibold text-slate-700">Leads que necesitan atención</p>
                </div>
                <LeadRows />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ShotKpi({ label, value, delta }: { label: string; value: string; delta: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <p className="text-[10px] font-medium text-slate-400">{label}</p>
      <div className="mt-1 flex items-end justify-between">
        <span className="text-lg font-semibold tracking-tight text-slate-900 tabular-nums">{value}</span>
        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 tabular-nums">
          {delta}
        </span>
      </div>
    </div>
  );
}

/* ----------------------------------------------------- SVG visualisations */
function AreaChart() {
  return (
    <svg viewBox="0 0 320 120" className="h-28 w-full" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2f74ff" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#2f74ff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[24, 54, 84].map((y) => (
        <line key={y} x1="0" y1={y} x2="320" y2={y} stroke="#eef2f7" strokeWidth="1" />
      ))}
      {/* previous period */}
      <path
        d="M0 96 C 30 92 52 90 78 82 S 128 78 158 80 S 214 66 250 70 S 300 60 320 62"
        fill="none"
        stroke="#cbd5e1"
        strokeWidth="2"
        strokeDasharray="3 3"
      />
      {/* this month */}
      <path d="M0 100 C 26 92 46 96 70 78 S 110 52 140 62 S 190 34 224 44 S 286 14 320 22 L320 120 L0 120 Z" fill="url(#areaFill)" />
      <path
        d="M0 100 C 26 92 46 96 70 78 S 110 52 140 62 S 190 34 224 44 S 286 14 320 22"
        fill="none"
        stroke="#2f74ff"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="320" cy="22" r="3.5" fill="#2f74ff" />
    </svg>
  );
}

function SourceBars() {
  const rows: [string, number, string][] = [
    ["WhatsApp (bot)", 68, "#2f74ff"],
    ["Meta Ads", 21, "#7c3aed"],
    ["Orgánico", 11, "#10b981"],
  ];
  return (
    <div className="space-y-3">
      {rows.map(([label, pct, color]) => (
        <div key={label}>
          <div className="mb-1 flex items-center justify-between text-[11px]">
            <span className="text-slate-600">{label}</span>
            <span className="font-semibold text-slate-500 tabular-nums">{pct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Funnel() {
  const steps: [string, string, number][] = [
    ["Conversaciones", "1,284", 100],
    ["Leads calificados", "512", 62],
    ["Órdenes creadas", "312", 40],
  ];
  return (
    <div className="space-y-2.5">
      {steps.map(([label, count, w], i) => (
        <div key={label} className="flex items-center gap-3">
          <div className="w-28 shrink-0 text-[11px] text-slate-500">{label}</div>
          <div className="h-7 flex-1 overflow-hidden rounded-md bg-slate-100">
            <div
              className="flex h-full items-center justify-end rounded-md px-2 text-[11px] font-semibold text-white tabular-nums"
              style={{
                width: `${w}%`,
                background:
                  i === 0
                    ? "linear-gradient(90deg,#8fbcff,#2f74ff)"
                    : i === 1
                      ? "linear-gradient(90deg,#5b93ff,#1f5fe0)"
                      : "linear-gradient(90deg,#1f5fe0,#1b4fbd)",
              }}
            >
              {count}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LeadRows() {
  const leads: [string, string, string, string][] = [
    ["A", "Ana Rojas", "Pidió precio, no cierra", "🔥 Caliente"],
    ["L", "Luis Medina", "Carrito abandonado", "🛒 Carrito"],
    ["S", "Sofía Paz", "Falta validar stock", "⏳ Pendiente"],
  ];
  return (
    <ul className="space-y-2">
      {leads.map(([ini, name, note, tag]) => (
        <li key={name} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/50 px-2.5 py-2">
          <span className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-white text-[10px] font-bold text-slate-500 ring-1 ring-slate-200">
              {ini}
            </span>
            <span>
              <span className="block text-[11px] font-semibold text-slate-700">{name}</span>
              <span className="block text-[10px] text-slate-400">{note}</span>
            </span>
          </span>
          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-slate-200">
            {tag}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* =========================================================== Stat band === */
function StatBand() {
  const stats: [string, string][] = [
    ["Tiempo real", "Webhooks + cron, sin exportar nada a mano"],
    ["4 familias de métricas", "Ventas · Conversión · Negocio · Operación"],
    ["Aislamiento por RLS", "Cada tienda ve solo lo suyo, a nivel de BD"],
    ["AES-256-GCM", "Credenciales cifradas en reposo"],
  ];
  return (
    <section className="border-y border-slate-100 bg-slate-50/50">
      <div className="mx-auto grid max-w-6xl grid-cols-2 divide-slate-200/70 px-5 py-10 sm:grid-cols-4 sm:divide-x">
        {stats.map(([big, small]) => (
          <div key={big} className="px-4 py-3 text-center sm:py-0">
            <p className="text-lg font-semibold tracking-tight text-slate-900">{big}</p>
            <p className="mt-1 text-xs leading-snug text-slate-500">{small}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ======================================================== Integrations === */
function Integrations() {
  const items = ["Shopify", "Kapso", "WhatsApp", "Meta Ads", "Telegram"];
  return (
    <section className="mx-auto max-w-6xl px-5 py-12">
      <p className="text-center text-xs font-medium tracking-wide text-slate-400 uppercase">
        Se conecta con las herramientas que ya usas
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-10 gap-y-4">
        {items.map((n) => (
          <span key={n} className="text-lg font-semibold text-slate-300 transition hover:text-slate-400">
            {n}
          </span>
        ))}
      </div>
    </section>
  );
}

/* ===================================================== Problem/Solution === */
function ProblemSolution() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-16">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-7">
          <span className="inline-flex rounded-full bg-slate-200/70 px-2.5 py-1 text-[11px] font-semibold text-slate-500">
            ANTES
          </span>
          <h3 className="mt-4 text-xl font-semibold tracking-tight text-slate-800">
            Tu data vive en cinco lugares distintos
          </h3>
          <ul className="mt-4 space-y-2.5 text-sm text-slate-500">
            {[
              "Shopify para las órdenes, Kapso para los chats",
              "Meta para el gasto, y todo cruzado en Excel a mano",
              "No sabes qué conversación se volvió venta",
              "Cada tienda mezclada con las demás",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2.5">
                <CrossIcon /> {t}
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl border border-brand-200 bg-brand-50/40 p-7 shadow-sm">
          <span className="inline-flex rounded-full bg-brand-600 px-2.5 py-1 text-[11px] font-semibold text-white">
            CON KAPSO SALES
          </span>
          <h3 className="mt-4 text-xl font-semibold tracking-tight text-slate-900">
            Una sola pantalla, actualizada sola
          </h3>
          <ul className="mt-4 space-y-2.5 text-sm text-slate-600">
            {[
              "Órdenes, chats y gasto unidos automáticamente",
              "Cada venta atribuida a su conversación de WhatsApp",
              "Conversión, AOV y ROAS calculados por ti",
              "Cada tienda y dueño 100% aislados",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2.5">
                <CheckIcon className="mt-0.5 text-brand-600" /> {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* =============================================================== Bento === */
function Bento() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-16 sm:py-24">
      <SectionHeading
        eyebrow="EL PRODUCTO"
        title="Todo tu negocio de WhatsApp, explicado con datos"
        sub="Cuatro familias de métricas y un tablero de leads — construidas sobre tu Shopify y tu Kapso, sin que muevas un dedo."
      />
      <div className="mt-12 grid gap-4 lg:grid-cols-6">
        {/* big: ventas */}
        <BentoCard className="lg:col-span-4" icon={<ChartIcon />} title="Ventas e ingresos"
          body="# de órdenes, ingresos netos, ticket promedio (AOV) y reembolsos. Serie diaria comparada con el periodo anterior, por tienda y consolidado.">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <AreaChart />
          </div>
        </BentoCard>

        {/* conversión */}
        <BentoCard className="lg:col-span-2" icon={<FunnelIcon />} title="Conversión chat → venta"
          body="Conversaciones de Kapso vs. órdenes con origen WhatsApp. Tasa por tienda y día, con enlace fino conversación ↔ orden.">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <Funnel />
          </div>
        </BentoCard>

        {/* leads */}
        <BentoCard className="lg:col-span-3" icon={<ChatIcon />} title="Leads de WhatsApp en vivo"
          body="Cada lead con su estado (caliente, carrito, sin stock), quién lo atiende y quién sigue pendiente. Con nota, teléfono y dirección de envío.">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <LeadRows />
          </div>
        </BentoCard>

        {/* atribución */}
        <BentoCard className="lg:col-span-3" icon={<TargetIcon />} title="Atribución Meta y ROAS"
          body="El gasto de cada anuncio ligado a órdenes reales. ROAS por campaña, sin planillas ni cálculos manuales.">
          <RoasTable />
        </BentoCard>
      </div>
    </section>
  );
}

function BentoCard({
  className = "",
  icon,
  title,
  body,
  children,
}: {
  className?: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-brand-200 hover:shadow-lg hover:shadow-brand-600/5 ${className}`}>
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">
          {icon}
        </span>
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      </div>
      <p className="mt-2.5 text-sm leading-relaxed text-slate-600">{body}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function RoasTable() {
  const rows: [string, string, string, string][] = [
    ["Promo Verano", "S/ 1,240", "38", "4.1x"],
    ["Retargeting", "S/ 680", "22", "3.4x"],
    ["Prospecting", "S/ 910", "18", "2.2x"],
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="grid grid-cols-[1.4fr_1fr_0.8fr_0.8fr] gap-2 border-b border-slate-100 bg-slate-50/60 px-3 py-2 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
        <span>Campaña</span><span>Gasto</span><span>Órdenes</span><span>ROAS</span>
      </div>
      {rows.map(([c, g, o, r], i) => (
        <div key={c} className="grid grid-cols-[1.4fr_1fr_0.8fr_0.8fr] items-center gap-2 px-3 py-2 text-[11px] tabular-nums">
          <span className="font-medium text-slate-700">{c}</span>
          <span className="text-slate-500">{g}</span>
          <span className="text-slate-500">{o}</span>
          <span className={`font-semibold ${i === 0 ? "text-emerald-600" : "text-slate-700"}`}>{r}</span>
        </div>
      ))}
    </div>
  );
}

/* ========================================================== Deep dives === */
function DeepDives() {
  return (
    <section className="border-y border-slate-100 bg-slate-50/50">
      <div className="mx-auto max-w-6xl space-y-20 px-5 py-20 sm:py-28">
        <DeepRow
          eyebrow="INGRESOS"
          title="Sabe exactamente cuánto entra, y de dónde"
          points={[
            ["Ingresos netos reales", "Descuenta reembolsos y órdenes canceladas — no infla el número."],
            ["Comparativa automática", "Cada métrica contra el periodo anterior, con su variación."],
            ["Por tienda y consolidado", "Un solo panel para todas tus tiendas, o el detalle de cada una."],
          ]}
          visual={
            <MockPanel title="Ingresos por día">
              <div className="grid grid-cols-3 gap-2">
                <ShotKpi label="Ingresos" value="S/ 48,290" delta="+12%" />
                <ShotKpi label="Reembolsos" value="S/ 1,180" delta="-4%" />
                <ShotKpi label="AOV" value="S/ 154" delta="+3%" />
              </div>
              <div className="mt-3 rounded-lg border border-slate-200 p-2.5"><AreaChart /></div>
            </MockPanel>
          }
        />
        <DeepRow
          reverse
          eyebrow="CONVERSIÓN"
          title="Descubre qué conversación se vuelve venta"
          points={[
            ["Embudo real", "De conversaciones a leads calificados a órdenes, con su tasa en cada paso."],
            ["Enlace fino", "Cada orden de Shopify unida a su conversación de Kapso por el bot."],
            ["Por asesora y fuente", "Quién convierte más y qué canal trae mejores ventas."],
          ]}
          visual={
            <MockPanel title="Embudo conversación → venta">
              <Funnel />
              <div className="mt-3"><SourceBars /></div>
            </MockPanel>
          }
        />
        <DeepRow
          eyebrow="LEADS"
          title="Que ningún cliente se quede sin respuesta"
          points={[
            ["Tablero en vivo", "Leads calientes, carritos y pendientes, ordenados por prioridad."],
            ["Contexto completo", "Nota del bot, teléfono, dirección de envío y estado de stock."],
            ["Operación clara", "Quién atiende cada lead y cuáles siguen sin tomar."],
          ]}
          visual={
            <MockPanel title="Leads que necesitan atención">
              <LeadRows />
            </MockPanel>
          }
        />
      </div>
    </section>
  );
}

function DeepRow({
  eyebrow,
  title,
  points,
  visual,
  reverse = false,
}: {
  eyebrow: string;
  title: string;
  points: [string, string][];
  visual: React.ReactNode;
  reverse?: boolean;
}) {
  return (
    <div className="grid items-center gap-10 lg:grid-cols-2">
      <div className={reverse ? "lg:order-2" : ""}>
        <p className="text-xs font-semibold tracking-wide text-brand-600">{eyebrow}</p>
        <h3 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{title}</h3>
        <ul className="mt-6 space-y-4">
          {points.map(([h, b]) => (
            <li key={h} className="flex gap-3">
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 ring-1 ring-brand-100">
                <CheckIcon className="scale-90" />
              </span>
              <span>
                <span className="block text-sm font-semibold text-slate-800">{h}</span>
                <span className="block text-sm text-slate-500">{b}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className={reverse ? "lg:order-1" : ""}>
        <div className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-6 -z-10 rounded-3xl blur-2xl"
            style={{ background: "radial-gradient(50% 50% at 50% 50%, rgba(47,116,255,0.12), rgba(255,255,255,0))" }}
          />
          {visual}
        </div>
      </div>
    </div>
  );
}

function MockPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xl shadow-slate-900/5">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-semibold text-slate-700">{title}</p>
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
          <span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-emerald-500" /> En vivo
        </span>
      </div>
      {children}
    </div>
  );
}

/* ============================================================ Security === */
function Security() {
  const points: [string, string][] = [
    ["Cifrado AES-256-GCM", "El token de Shopify, el secreto de webhooks y la API key de Kapso se guardan cifrados en reposo."],
    ["Aislamiento a nivel de base de datos", "Row Level Security filtra cada consulta por tienda: nadie ve lo que no le toca, ni por error."],
    ["Secreto de webhook por tienda", "Cada tienda autentica sus webhooks con su propio secreto, verificado en tiempo constante."],
    ["Tus tokens nunca viajan al navegador", "Se descifran solo en el servidor, bajo demanda. Jamás llegan al cliente ni a los logs."],
  ];
  return (
    <section id="seguridad" className="mx-auto max-w-6xl px-5 py-20 scroll-mt-20 sm:py-24">
      <div className="relative overflow-hidden rounded-[2rem] bg-slate-950 px-6 py-14 sm:px-14 sm:py-20">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -right-24 h-80 w-80 rounded-full blur-3xl"
          style={{ background: "radial-gradient(circle, rgba(47,116,255,0.40), rgba(2,6,23,0))" }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full blur-3xl"
          style={{ background: "radial-gradient(circle, rgba(124,58,237,0.28), rgba(2,6,23,0))" }}
        />
        <div className="relative grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-brand-200">
              <ShieldIcon /> Seguridad de nivel empresa
            </span>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-[2.75rem] sm:leading-[1.05]">
              Tu data y la de tus clientes, protegidas de verdad.
            </h2>
            <p className="mt-5 max-w-md text-slate-300">
              No es una promesa de marketing. El aislamiento entre tiendas se aplica en la base de
              datos y las credenciales se cifran. Pensado para operar decenas de tiendas de distintos
              dueños sin que una vea a la otra.
            </p>
            <div className="mt-7 flex flex-wrap gap-2">
              {["AES-256-GCM", "Row Level Security", "HMAC en webhooks", "Tokens server-only"].map((t) => (
                <span key={t} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-slate-200">
                  {t}
                </span>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            {points.map(([h, b]) => (
              <div key={h} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-400">
                    <CheckIcon className="scale-90" />
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-white">{h}</p>
                    <p className="mt-1 text-[13px] leading-relaxed text-slate-400">{b}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ========================================================= How it works == */
function HowItWorks() {
  const steps: [string, string][] = [
    ["Crea tu cuenta", "Entra con Google en segundos. Sin tarjeta, sin instalar nada, sin llamadas de ventas."],
    ["Conecta tu tienda", "Pega tu token de Shopify y tu API key de Kapso. Se cifran al instante y registramos los webhooks por ti."],
    ["Vende con datos", "Tu panel se llena solo con backfill inicial + sincronización continua. Mira qué funciona y dobla la apuesta."],
  ];
  return (
    <section id="como" className="mx-auto max-w-6xl px-5 py-20 scroll-mt-20 sm:py-24">
      <SectionHeading eyebrow="CÓMO FUNCIONA" title="En marcha en 3 pasos, en menos de 5 minutos" />
      <div className="mt-14 grid gap-6 sm:grid-cols-3">
        {steps.map(([title, body], i) => (
          <div key={title} className="relative rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-600 text-sm font-bold text-white tabular-nums">
                {i + 1}
              </span>
              {i < 2 && <div className="hidden h-px flex-1 bg-gradient-to-r from-brand-200 to-transparent sm:block" />}
            </div>
            <h3 className="mt-4 text-lg font-semibold text-slate-900">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">{body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ================================================================= FAQ === */
function Faq() {
  const qa: [string, string][] = [
    ["¿Mi data se mezcla con la de otras tiendas?", "No. Cada dueño tiene su propio espacio y la base de datos filtra cada consulta por tienda (Row Level Security). Es imposible ver la data de otro, incluso por error."],
    ["¿Necesito instalar algo o programar?", "No. Entras con Google, pegas tus credenciales de Shopify y Kapso, y listo. Nosotros registramos los webhooks y hacemos la sincronización."],
    ["¿Con qué se conecta?", "Con Shopify (órdenes), Kapso (conversaciones de WhatsApp), Meta Ads (gasto y atribución) y Telegram (resúmenes diarios)."],
    ["¿Qué tan segura está mi información?", "Tus credenciales se cifran con AES-256-GCM y solo se descifran en el servidor. Nunca viajan al navegador ni quedan en los logs."],
    ["¿En cuánto tiempo veo mis datos?", "El backfill inicial trae tu histórico al conectar, y de ahí en adelante todo se actualiza en tiempo real por webhooks y cron."],
  ];
  return (
    <section id="faq" className="border-y border-slate-100 bg-slate-50/50 scroll-mt-20">
      <div className="mx-auto max-w-3xl px-5 py-20 sm:py-24">
        <SectionHeading eyebrow="PREGUNTAS FRECUENTES" title="Lo que probablemente te estás preguntando" />
        <div className="mt-12 divide-y divide-slate-200">
          {qa.map(([q, a]) => (
            <div key={q} className="py-5">
              <p className="flex items-start gap-2 text-[15px] font-semibold text-slate-900">
                <span className="text-brand-600">Q.</span> {q}
              </p>
              <p className="mt-2 pl-6 text-sm leading-relaxed text-slate-600">{a}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* =========================================================== Final CTA === */
function FinalCta() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-20 sm:py-24">
      <div
        className="relative overflow-hidden rounded-[2rem] px-6 py-16 text-center sm:px-12 sm:py-20"
        style={{ background: "linear-gradient(135deg, #1b4fbd 0%, #2f74ff 50%, #7c3aed 130%)" }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{ background: "radial-gradient(40% 60% at 78% 18%, rgba(255,255,255,0.35), rgba(255,255,255,0))" }}
        />
        <div className="relative">
          <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-[2.75rem] sm:leading-[1.05]">
            Empieza a medir tus ventas de WhatsApp hoy.
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-brand-50/90">
            Crea tu cuenta gratis y conecta tu tienda en minutos. Sin tarjeta, sin compromiso.
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/signup"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-7 py-3.5 text-sm font-semibold text-brand-700 shadow-lg transition hover:bg-brand-50 sm:w-auto"
            >
              Crea tu cuenta gratis <ArrowIcon />
            </Link>
            <Link
              href="/login"
              className="inline-flex w-full items-center justify-center rounded-xl border border-white/30 px-7 py-3.5 text-sm font-semibold text-white transition hover:bg-white/10 sm:w-auto"
            >
              Iniciar sesión
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================================================== Footer === */
function Footer() {
  return (
    <footer className="border-t border-slate-200">
      <div className="mx-auto max-w-6xl px-5 py-12">
        <div className="flex flex-col justify-between gap-8 sm:flex-row">
          <div className="max-w-xs">
            <div className="flex items-center gap-2.5">
              <Logo />
              <span className="text-[15px] font-semibold tracking-tight">Kapso Sales</span>
            </div>
            <p className="mt-3 text-sm text-slate-500">
              El panel de ventas para tiendas que venden por WhatsApp. Shopify + Kapso, en una pantalla.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
            <FooterCol title="Producto" links={[["Métricas", "#producto"], ["Seguridad", "#seguridad"], ["Cómo funciona", "#como"]]} />
            <FooterCol title="Recursos" links={[["Preguntas", "#faq"], ["Iniciar sesión", "/login"], ["Crear cuenta", "/signup"]]} />
            <FooterCol title="Empezar" links={[["Crea tu cuenta", "/signup"]]} />
          </div>
        </div>
        <div className="mt-10 flex flex-col items-center justify-between gap-3 border-t border-slate-100 pt-6 text-xs text-slate-400 sm:flex-row">
          <p>© Kapso Sales · Panel de ventas multi-tienda.</p>
          <p>Hecho para tiendas de WhatsApp.</p>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <p className="text-xs font-semibold tracking-wide text-slate-400 uppercase">{title}</p>
      <ul className="mt-3 space-y-2">
        {links.map(([label, href]) => (
          <li key={label}>
            <a href={href} className="text-sm text-slate-600 transition hover:text-slate-900">
              {label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ====================================================== Shared / icons === */
function SectionHeading({ eyebrow, title, sub }: { eyebrow: string; title: string; sub?: string }) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="text-xs font-semibold tracking-wide text-brand-600">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">{title}</h2>
      {sub && <p className="mt-4 text-slate-600">{sub}</p>}
    </div>
  );
}

function Logo({ sm = false }: { sm?: boolean }) {
  const s = sm ? "h-6 w-6" : "h-8 w-8";
  return (
    <span
      className={`grid ${s} place-items-center rounded-lg text-white shadow-sm`}
      style={{ background: "linear-gradient(135deg, #1f5fe0, #2f74ff)" }}
      aria-hidden
    >
      <svg width={sm ? 13 : 16} height={sm ? 13 : 16} viewBox="0 0 24 24" fill="none">
        <path d="M4 15l4-5 4 3 4-7 4 5" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}
function ArrowIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function LockMini() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
      <path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function ChartIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 19V5M4 19h16M8 16v-4M12 16V8M16 16v-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H9l-4 4V6z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
function FunnelIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 5h16l-6 7v6l-4 2v-8L4 5z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
function TargetIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}
function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CrossIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden className="mt-0.5 shrink-0 text-slate-300">
      <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
