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
      <Recovery />
      <DeepDives />
      <Personalization />
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
  const links: [string, string][] = [
    ["Producto", "#producto"],
    ["Recuperación", "#recuperacion"],
    ["Equipo & IA", "#equipo"],
    ["Seguridad", "#seguridad"],
  ];
  return (
    <header className="sticky top-0 z-50 border-b border-slate-200/60 bg-white/75 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">Kapso Sales</span>
        </div>
        <nav className="hidden items-center gap-1 lg:flex">
          {links.map(([label, href]) => (
            <a key={label} href={href} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:text-slate-900">
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2 sm:gap-3">
          <Link href="/login" className="hidden rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition hover:text-slate-900 sm:block">
            Iniciar sesión
          </Link>
          <Link href="/signup" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800">
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
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/70 py-1.5 pr-3 pl-1.5 text-xs font-medium text-slate-600 shadow-sm backdrop-blur">
            <span className="rounded-full bg-brand-600 px-2 py-0.5 text-[10px] font-bold tracking-wide text-white">NUEVO</span>
            Ventas · Recuperación · IA — para tiendas de WhatsApp
          </span>
        </div>

        <h1 className="mx-auto mt-7 max-w-4xl animate-fade-up text-[2.5rem] leading-[1.03] font-semibold tracking-[-0.03em] text-slate-900 sm:text-[4.1rem]" style={{ animationDelay: "60ms" }}>
          Convierte hasta el{" "}
          <span className="bg-gradient-to-r from-brand-700 via-brand-500 to-brand-600 bg-clip-text text-transparent">20%</span>{" "}
          de tus chats de WhatsApp en ventas.
        </h1>

        <p className="mx-auto mt-6 max-w-2xl animate-fade-up text-lg leading-relaxed text-slate-600" style={{ animationDelay: "120ms" }}>
          La tasa de conversión <strong className="font-semibold text-slate-800">más alta del mercado</strong>, en un panel{" "}
          <strong className="font-semibold text-slate-800">100% adaptado a tu forma de trabajar</strong>. Mide, recupera y clasifica cada
          conversación — con tu Shopify, tu Kapso y Claude, todo conectado.
        </p>

        <div className="mt-9 flex animate-fade-up flex-col items-center justify-center gap-3 sm:flex-row" style={{ animationDelay: "180ms" }}>
          <Link href="/signup" className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-brand-600/25 transition hover:bg-brand-700 sm:w-auto">
            Crea tu cuenta gratis <ArrowIcon />
          </Link>
          <a href="#producto" className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 sm:w-auto">
            <PlayIcon /> Ver el producto
          </a>
        </div>

        <p className="mt-4 animate-fade-up text-xs text-slate-400" style={{ animationDelay: "240ms" }}>
          Sin tarjeta · Conectas en 5 minutos · Multi-tienda y multi-asesor
        </p>
      </div>

      <div id="producto" className="relative z-10 mx-auto max-w-6xl animate-fade-up px-5 pb-4 scroll-mt-20" style={{ animationDelay: "300ms" }}>
        <AppShot />
      </div>
    </section>
  );
}

function GridGlow() {
  return (
    <>
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0" style={{
        backgroundImage: "linear-gradient(to right, rgba(15,23,42,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(15,23,42,0.04) 1px, transparent 1px)",
        backgroundSize: "44px 44px",
        maskImage: "radial-gradient(70% 55% at 50% 25%, black, transparent 80%)",
        WebkitMaskImage: "radial-gradient(70% 55% at 50% 25%, black, transparent 80%)",
      }} />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-32 z-0 mx-auto h-[560px] max-w-4xl animate-sheen blur-3xl" style={{
        background: "radial-gradient(55% 55% at 50% 30%, rgba(47,116,255,0.30) 0%, rgba(124,58,237,0.12) 45%, rgba(255,255,255,0) 74%)",
      }} />
    </>
  );
}

/* ------------------------------------------------- Full app screenshot --- */
function AppShot() {
  return (
    <div className="relative">
      <div aria-hidden className="pointer-events-none absolute -inset-10 -z-10 rounded-[2.5rem] blur-3xl" style={{ background: "radial-gradient(45% 50% at 50% 35%, rgba(47,116,255,0.20), rgba(255,255,255,0))" }} />
      <div className="animate-float overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-2xl shadow-slate-900/15 ring-1 ring-slate-900/5">
        <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50/80 px-4 py-2.5">
          <span className="h-3 w-3 rounded-full bg-slate-300" />
          <span className="h-3 w-3 rounded-full bg-slate-300" />
          <span className="h-3 w-3 rounded-full bg-slate-300" />
          <div className="mx-auto flex items-center gap-1.5 rounded-md bg-white px-3 py-1 text-[11px] text-slate-400 ring-1 ring-slate-200">
            <LockMini /> app.kapsosales.com / dashboard
          </div>
        </div>
        <div className="flex text-left">
          <aside className="hidden w-44 shrink-0 border-r border-slate-100 bg-slate-50/40 p-3 md:block">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <Logo sm />
              <span className="text-xs font-semibold text-slate-700">Kapso Sales</span>
            </div>
            <nav className="mt-3 space-y-0.5">
              {([["Resumen", true], ["Ventas", false], ["Conversión", false], ["Leads", false], ["Atribución Meta", false], ["Envíos", false], ["Equipo", false]] as [string, boolean][]).map(([label, active]) => (
                <div key={label} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] ${active ? "bg-brand-50 font-semibold text-brand-700" : "text-slate-500"}`}>
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
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <ShotKpi label="Ingresos netos" value="S/ 48,290" delta="+12%" />
              <ShotKpi label="Órdenes" value="312" delta="+8%" />
              <ShotKpi label="Conv. chat→venta" value="20%" delta="+3pts" hi />
              <ShotKpi label="Recuperado (30d)" value="S/ 7,140" delta="+18%" />
            </div>
            <div className="mt-3 grid gap-3 lg:grid-cols-3">
              <div className="rounded-xl border border-slate-200 bg-white p-3.5 lg:col-span-2">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold text-slate-700">Ingresos por día</p>
                  <div className="flex items-center gap-2 text-[10px] text-slate-400">
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-brand-500" /> Este mes</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-300" /> Anterior</span>
                  </div>
                </div>
                <AreaChart />
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3.5">
                <p className="mb-3 text-xs font-semibold text-slate-700">Origen de ventas</p>
                <Donut />
              </div>
            </div>
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

function ShotKpi({ label, value, delta, hi = false }: { label: string; value: string; delta: string; hi?: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${hi ? "border-brand-200 bg-brand-50/40" : "border-slate-200 bg-white"}`}>
      <p className="text-[10px] font-medium text-slate-400">{label}</p>
      <div className="mt-1 flex items-end justify-between">
        <span className={`text-lg font-semibold tracking-tight tabular-nums ${hi ? "text-brand-700" : "text-slate-900"}`}>{value}</span>
        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 tabular-nums">{delta}</span>
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
      {[24, 54, 84].map((y) => (<line key={y} x1="0" y1={y} x2="320" y2={y} stroke="#eef2f7" strokeWidth="1" />))}
      <path d="M0 96 C 30 92 52 90 78 82 S 128 78 158 80 S 214 66 250 70 S 300 60 320 62" fill="none" stroke="#cbd5e1" strokeWidth="2" strokeDasharray="3 3" />
      <path d="M0 100 C 26 92 46 96 70 78 S 110 52 140 62 S 190 34 224 44 S 286 14 320 22 L320 120 L0 120 Z" fill="url(#areaFill)" />
      <path d="M0 100 C 26 92 46 96 70 78 S 110 52 140 62 S 190 34 224 44 S 286 14 320 22" fill="none" stroke="#2f74ff" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="320" cy="22" r="3.5" fill="#2f74ff" />
    </svg>
  );
}

function Donut() {
  const segs: [string, number, string][] = [["WhatsApp", 68, "#2f74ff"], ["Meta Ads", 21, "#7c3aed"], ["Orgánico", 11, "#10b981"]];
  const R = 30;
  const C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 80 80" className="h-[88px] w-[88px] shrink-0 -rotate-90" aria-hidden>
        <circle cx="40" cy="40" r={R} fill="none" stroke="#eef2f7" strokeWidth="13" />
        {segs.map(([label, pct, color]) => {
          const len = (pct / 100) * C;
          const el = (
            <circle key={label} cx="40" cy="40" r={R} fill="none" stroke={color} strokeWidth="13" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-acc} />
          );
          acc += len;
          return el;
        })}
      </svg>
      <ul className="space-y-1.5 text-[11px]">
        {segs.map(([label, pct, color]) => (
          <li key={label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: color }} />
            <span className="text-slate-600">{label}</span>
            <span className="ml-auto font-semibold text-slate-500 tabular-nums">{pct}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Gauge() {
  const pct = 20;
  const ARC = Math.PI * 36; // semicircle length ≈ 113
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 90 54" className="w-40" aria-hidden>
        <defs>
          <linearGradient id="gg" x1="0" x2="1"><stop offset="0" stopColor="#8fbcff" /><stop offset="1" stopColor="#2f74ff" /></linearGradient>
        </defs>
        <path d="M9 47 A36 36 0 0 1 81 47" fill="none" stroke="#eef2f7" strokeWidth="9" strokeLinecap="round" />
        <path d="M9 47 A36 36 0 0 1 81 47" fill="none" stroke="url(#gg)" strokeWidth="9" strokeLinecap="round" strokeDasharray={`${(pct / 100) * ARC} ${ARC}`} />
      </svg>
      <div className="-mt-7 text-center">
        <p className="text-3xl font-bold tracking-tight text-brand-700 tabular-nums">20%</p>
        <p className="text-[10px] text-slate-400">chat → venta</p>
      </div>
    </div>
  );
}

function VerticalBars() {
  const bars = [40, 52, 44, 63, 58, 72, 66, 84, 70, 90, 78, 96];
  return (
    <div className="flex h-28 items-end gap-1.5">
      {bars.map((h, i) => (
        <div key={i} className="flex-1 rounded-t-sm" style={{ height: `${h}%`, background: "linear-gradient(180deg,#2f74ff,#bcd4ff)", opacity: 0.5 + (i / bars.length) * 0.5 }} />
      ))}
    </div>
  );
}

function Leaderboard() {
  const rows: [string, string, string][] = [["María", "asesora", "S/ 9,120"], ["Carla", "asesora", "S/ 7,340"], ["José", "admin", "S/ 4,010"]];
  const medal = ["🥇", "🥈", "🥉"];
  return (
    <ul className="space-y-2">
      {rows.map(([name, role, sales], i) => (
        <li key={name} className="flex items-center gap-3 rounded-lg border border-slate-100 bg-slate-50/50 px-2.5 py-2">
          <span className="text-sm">{medal[i]}</span>
          <span className="grid h-7 w-7 place-items-center rounded-full bg-white text-[10px] font-bold text-slate-500 ring-1 ring-slate-200">{name[0]}</span>
          <span className="flex-1 text-[11px]"><span className="font-semibold text-slate-700">{name}</span> <span className="text-slate-400">· {role}</span></span>
          <span className="text-[11px] font-semibold text-slate-700 tabular-nums">{sales}</span>
        </li>
      ))}
    </ul>
  );
}

function Funnel() {
  const steps: [string, string, number][] = [["Conversaciones", "1,284", 100], ["Leads calificados", "512", 62], ["Órdenes creadas", "312", 40]];
  return (
    <div className="space-y-2.5">
      {steps.map(([label, count, w], i) => (
        <div key={label} className="flex items-center gap-3">
          <div className="w-28 shrink-0 text-[11px] text-slate-500">{label}</div>
          <div className="h-7 flex-1 overflow-hidden rounded-md bg-slate-100">
            <div className="flex h-full items-center justify-end rounded-md px-2 text-[11px] font-semibold text-white tabular-nums" style={{
              width: `${w}%`,
              background: i === 0 ? "linear-gradient(90deg,#8fbcff,#2f74ff)" : i === 1 ? "linear-gradient(90deg,#5b93ff,#1f5fe0)" : "linear-gradient(90deg,#1f5fe0,#1b4fbd)",
            }}>{count}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LeadRows() {
  const leads: [string, string, string, string, string][] = [
    ["A", "Ana Rojas", "Pidió precio, no cierra", "Caliente", "bg-rose-50 text-rose-600"],
    ["L", "Luis Medina", "Carrito abandonado", "Carrito", "bg-amber-50 text-amber-600"],
    ["S", "Sofía Paz", "Falta validar stock", "Pendiente", "bg-slate-100 text-slate-500"],
  ];
  return (
    <ul className="space-y-2">
      {leads.map(([ini, name, note, tag, cls]) => (
        <li key={name} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/50 px-2.5 py-2">
          <span className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-white text-[10px] font-bold text-slate-500 ring-1 ring-slate-200">{ini}</span>
            <span><span className="block text-[11px] font-semibold text-slate-700">{name}</span><span className="block text-[10px] text-slate-400">{note}</span></span>
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cls}`}>{tag}</span>
        </li>
      ))}
    </ul>
  );
}

/* =========================================================== Stat band === */
function StatBand() {
  const stats: [string, string][] = [
    ["Hasta 20%", "Conversión chat → venta, la más alta del mercado"],
    ["3 flujos de recuperación", "Carritos, búsquedas abandonadas y winback 60 días"],
    ["Multi-asesor", "Roles, permisos y productividad por vendedora"],
    ["Cifrado + RLS", "Tu data aislada, credenciales AES-256"],
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
  return (
    <section className="mx-auto max-w-6xl px-5 py-12">
      <p className="text-center text-xs font-medium tracking-wide text-slate-400 uppercase">Conecta todo lo que ya usas — y también con Claude</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-x-9 gap-y-4">
        {["Shopify", "Kapso", "WhatsApp", "Meta Ads", "Telegram"].map((n) => (
          <span key={n} className="text-lg font-semibold text-slate-300 transition hover:text-slate-400">{n}</span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-lg font-semibold text-slate-400">
          <ClaudeMark /> Claude <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-slate-400">MCP</span>
        </span>
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
          <span className="inline-flex rounded-full bg-slate-200/70 px-2.5 py-1 text-[11px] font-semibold text-slate-500">ANTES</span>
          <h3 className="mt-4 text-xl font-semibold tracking-tight text-slate-800">Vendes por WhatsApp a ciegas</h3>
          <ul className="mt-4 space-y-2.5 text-sm text-slate-500">
            {["Shopify por un lado, Kapso por otro, Meta en otra pestaña", "Carritos y clientes perdidos que nadie recupera", "No sabes qué asesora convierte ni qué chat se volvió venta", "Cada tienda mezclada con las demás"].map((t) => (
              <li key={t} className="flex items-start gap-2.5"><CrossIcon /> {t}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl border border-brand-200 bg-brand-50/40 p-7 shadow-sm">
          <span className="inline-flex rounded-full bg-brand-600 px-2.5 py-1 text-[11px] font-semibold text-white">CON KAPSO SALES</span>
          <h3 className="mt-4 text-xl font-semibold tracking-tight text-slate-900">Cada chat, medido y aprovechado</h3>
          <ul className="mt-4 space-y-2.5 text-sm text-slate-600">
            {["Órdenes, chats y gasto unidos automáticamente", "Carritos, búsquedas y clientes de 60 días recuperados solos", "Conversión y productividad por asesora, en tiempo real", "Cada tienda y dueño 100% aislados"].map((t) => (
              <li key={t} className="flex items-start gap-2.5"><CheckIcon className="mt-0.5 text-brand-600" /> {t}</li>
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
      <SectionHeading eyebrow="EL PRODUCTO" title="Todo tu negocio de WhatsApp, en una sola plataforma" sub="Mide, recupera, clasifica y automatiza — construido sobre tu Shopify y tu Kapso, sin que muevas un dedo." />
      <div className="mt-12 grid gap-4 lg:grid-cols-6">
        <BentoCard className="lg:col-span-4" icon={<ChartIcon />} title="Ventas e ingresos reales" body="# de órdenes, ingresos netos (descuenta reembolsos y cancelaciones), ticket promedio y serie diaria vs. periodo anterior — por tienda y consolidado.">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between text-[11px] text-slate-400"><span className="font-semibold text-slate-600">Ventas por día</span><span>12 semanas</span></div>
            <VerticalBars />
          </div>
        </BentoCard>
        <BentoCard className="lg:col-span-2" icon={<FunnelIcon />} title="20% de conversión chat → venta" body="La tasa más alta del mercado. Mide conversaciones vs. órdenes por tienda, día y asesora.">
          <div className="rounded-xl border border-slate-200 bg-white p-4"><Gauge /></div>
        </BentoCard>
        <BentoCard className="lg:col-span-2" icon={<RefreshIcon />} title="Recuperación automática" body="Carritos abandonados, búsquedas abandonadas y clientes de 60+ días — reenganchados por WhatsApp sin que muevas un dedo.">
          <RecoveryMini />
        </BentoCard>
        <BentoCard className="lg:col-span-2" icon={<ChatIcon />} title="Leads clasificados solos" body="Cada lead se marca frío, tibio, caliente, carrito o pendiente. Prioriza a quién atender y no dejes a nadie sin respuesta.">
          <div className="rounded-xl border border-slate-200 bg-white p-3"><LeadRows /></div>
        </BentoCard>
        <BentoCard className="lg:col-span-2" icon={<TargetIcon />} title="Atribución Meta & ROAS" body="El gasto de cada anuncio ligado a órdenes reales. ROAS por campaña, sin planillas ni cálculos manuales.">
          <RoasTable />
        </BentoCard>
      </div>
    </section>
  );
}

function BentoCard({ className = "", icon, title, body, children }: { className?: string; icon: React.ReactNode; title: string; body: string; children: React.ReactNode }) {
  return (
    <div className={`flex flex-col rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-brand-200 hover:shadow-lg hover:shadow-brand-600/5 ${className}`}>
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">{icon}</span>
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      </div>
      <p className="mt-2.5 text-sm leading-relaxed text-slate-600">{body}</p>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function RoasTable() {
  const rows: [string, string, string, string][] = [["Promo Verano", "S/ 1,240", "38", "4.1x"], ["Retargeting", "S/ 680", "22", "3.4x"], ["Prospecting", "S/ 910", "18", "2.2x"]];
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="grid grid-cols-[1.4fr_1fr_0.8fr_0.8fr] gap-2 border-b border-slate-100 bg-slate-50/60 px-3 py-2 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">
        <span>Campaña</span><span>Gasto</span><span>Órdenes</span><span>ROAS</span>
      </div>
      {rows.map(([c, g, o, r], i) => (
        <div key={c} className="grid grid-cols-[1.4fr_1fr_0.8fr_0.8fr] items-center gap-2 px-3 py-2 text-[11px] tabular-nums">
          <span className="font-medium text-slate-700">{c}</span><span className="text-slate-500">{g}</span><span className="text-slate-500">{o}</span>
          <span className={`font-semibold ${i === 0 ? "text-emerald-600" : "text-slate-700"}`}>{r}</span>
        </div>
      ))}
    </div>
  );
}

function RecoveryMini() {
  const rows: [string, string][] = [["🛒 Carrito abandonado", "reabierto"], ["🔎 Búsqueda abandonada", "mensaje enviado"], ["↩️ Winback 60 días", "recuperado"]];
  return (
    <div className="space-y-2">
      {rows.map(([label, state]) => (
        <div key={label} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/50 px-2.5 py-2 text-[11px]">
          <span className="text-slate-600">{label}</span>
          <span className="inline-flex items-center gap-1 font-semibold text-emerald-600"><CheckIcon className="scale-75" /> {state}</span>
        </div>
      ))}
    </div>
  );
}

/* =========================================================== Recovery === */
function Recovery() {
  const cards: [React.ReactNode, string, string, string][] = [
    [<CartIcon key="c" />, "Carritos abandonados", "Cada carrito sin pagar vuelve como lead — con productos y dirección de envío — listo para cerrar por WhatsApp.", "Hola 👋 vi que dejaste tu pedido a medias. ¿Te ayudo a completarlo?"],
    [<SearchIcon key="s" />, "Búsquedas abandonadas", "Un cliente mira un producto y se va: Shopify Flow lo detecta y le manda una plantilla de WhatsApp para traerlo de vuelta.", "¿Seguís interesada en el modelo que viste? Tengo stock y envío hoy 📦"],
    [<RefreshIcon key="w" />, "Winback 60 días", "Clientes que llevan ~60 días sin comprar reciben un mensaje de recuperación automático, con seguimiento.", "¡Te extrañamos! 🎁 Tenemos algo especial para tu próxima compra."],
  ];
  return (
    <section id="recuperacion" className="border-y border-slate-100 bg-slate-50/50 scroll-mt-20">
      <div className="mx-auto max-w-6xl px-5 py-20 sm:py-24">
        <SectionHeading eyebrow="RECUPERACIÓN DE VENTAS" title="Recupera lo que otros dejan escapar" sub="Tres automatizaciones que traen de vuelta a los clientes que se fueron — sin que tú hagas nada. La plata que ya no se pierde." />
        <div className="mt-12 grid gap-5 lg:grid-cols-3">
          {cards.map(([icon, title, body, msg]) => (
            <div key={title} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-600 ring-1 ring-brand-100">{icon}</span>
              <h3 className="mt-4 text-lg font-semibold text-slate-900">{title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-600">{body}</p>
              <div className="mt-5 max-w-[85%] rounded-2xl rounded-bl-sm bg-[#25D366]/10 px-3.5 py-2.5 text-[12px] leading-snug text-slate-700 ring-1 ring-[#25D366]/20">
                {msg}
                <span className="mt-1 block text-right text-[9px] text-slate-400">WhatsApp · automático ✓✓</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ========================================================== Deep dives === */
function DeepDives() {
  return (
    <section id="equipo" className="mx-auto max-w-6xl space-y-20 px-5 py-20 scroll-mt-20 sm:py-28">
      <DeepRow
        eyebrow="CONVERSIÓN & ATRIBUCIÓN"
        title="Descubre qué chat se vuelve venta — y qué anuncio lo trajo"
        points={[
          ["Embudo real", "De conversaciones a leads calificados a órdenes, con la tasa en cada paso."],
          ["Enlace fino chat ↔ orden", "Cada venta de Shopify unida a su conversación de Kapso por el bot."],
          ["ROAS sin planillas", "El gasto de Meta ligado a órdenes reales, por campaña y anuncio."],
        ]}
        visual={
          <MockPanel title="Embudo de conversión">
            <Funnel />
            <div className="mt-3 grid grid-cols-3 gap-2">
              <ShotKpi label="Conversión" value="20%" delta="+3pts" hi />
              <ShotKpi label="Leads" value="512" delta="+9%" />
              <ShotKpi label="Órdenes" value="312" delta="+8%" />
            </div>
          </MockPanel>
        }
      />
      <DeepRow
        reverse
        eyebrow="LEADS & EQUIPO"
        title="Un equipo que sabe exactamente a quién atender"
        points={[
          ["Clasificación automática", "Frío, tibio, caliente, carrito o pendiente — el bot marca la temperatura de cada lead."],
          ["Multi-asesor y multi-admin", "Suma a tu equipo con roles (owner, admin, asesora, viewer). Cada quien ve solo lo que le toca."],
          ["Productividad por asesora", "Quién atiende, quién cierra y cuánto vende cada persona — hoy, ayer y por rango."],
        ]}
        visual={
          <MockPanel title="Equipo & leads">
            <LeadRows />
            <p className="mt-4 mb-2 text-[10px] font-semibold tracking-wide text-slate-400 uppercase">Ranking de asesoras (30d)</p>
            <Leaderboard />
          </MockPanel>
        }
      />
      <DeepRow
        eyebrow="IA & AUTOMATIZACIÓN"
        title="La IA hace el trabajo aburrido por ti"
        points={[
          ["Vouchers de Yape leídos por Claude", "La visión de Claude lee el comprobante y confirma el pago solo, sin que nadie transcriba nada."],
          ["Conexión con Claude vía MCP", "Lleva tus datos de ventas a Claude y pregúntale lo que quieras en lenguaje natural."],
          ["Resumen diario a Telegram", "Pedidos, ingresos y pendientes del día llegan solos a tu Telegram — sin abrir el panel."],
        ]}
        visual={
          <MockPanel title="IA & automatización">
            <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3">
              <span className="mt-0.5"><ClaudeMark big /></span>
              <div className="text-[11px]">
                <p className="font-semibold text-slate-700">Claude leyó el voucher de Yape</p>
                <p className="text-slate-500">S/ 154.00 · confirmado ✓ · asignado a María</p>
              </div>
            </div>
            <div className="mt-3 rounded-xl bg-[#229ED9]/10 p-3 ring-1 ring-[#229ED9]/20">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[#229ED9]"><TelegramIcon /> Resumen de hoy</p>
              <p className="mt-1 text-[11px] leading-snug text-slate-600">🛒 42 pedidos · 💰 S/ 6,480 · 🔥 8 leads calientes · ⏳ 3 por validar stock</p>
            </div>
          </MockPanel>
        }
      />
    </section>
  );
}

function DeepRow({ eyebrow, title, points, visual, reverse = false }: { eyebrow: string; title: string; points: [string, string][]; visual: React.ReactNode; reverse?: boolean }) {
  return (
    <div className="grid items-center gap-10 lg:grid-cols-2">
      <div className={reverse ? "lg:order-2" : ""}>
        <p className="text-xs font-semibold tracking-wide text-brand-600">{eyebrow}</p>
        <h3 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">{title}</h3>
        <ul className="mt-6 space-y-4">
          {points.map(([h, b]) => (
            <li key={h} className="flex gap-3">
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-600 ring-1 ring-brand-100"><CheckIcon className="scale-90" /></span>
              <span><span className="block text-sm font-semibold text-slate-800">{h}</span><span className="block text-sm text-slate-500">{b}</span></span>
            </li>
          ))}
        </ul>
      </div>
      <div className={reverse ? "lg:order-1" : ""}>
        <div className="relative">
          <div aria-hidden className="pointer-events-none absolute -inset-6 -z-10 rounded-3xl blur-2xl" style={{ background: "radial-gradient(50% 50% at 50% 50%, rgba(47,116,255,0.12), rgba(255,255,255,0))" }} />
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
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-600"><span className="h-1.5 w-1.5 animate-pulse-dot rounded-full bg-emerald-500" /> En vivo</span>
      </div>
      {children}
    </div>
  );
}

/* ====================================================== Personalization === */
function Personalization() {
  const chips = ["Plantillas de WhatsApp configurables", "Estados de lead a tu medida", "Reglas de operación", "Multi-tienda", "Moneda y zona horaria", "Enrutado de Yape por turnos"];
  return (
    <section className="mx-auto max-w-6xl px-5 py-8 sm:py-12">
      <div className="rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-8 text-center sm:p-12">
        <p className="text-xs font-semibold tracking-wide text-brand-600">100% A TU FORMA DE TRABAJAR</p>
        <h2 className="mx-auto mt-3 max-w-2xl text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">Kapso Sales se adapta a tu proceso, no al revés</h2>
        <p className="mx-auto mt-3 max-w-xl text-slate-600">Plantillas, estados de lead y reglas configurables. Lo ajustas a cómo vende tu tienda hoy — y crece contigo.</p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          {chips.map((c) => (
            <span key={c} className="rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-600 shadow-sm">{c}</span>
          ))}
        </div>
      </div>
    </section>
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
        <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 h-80 w-80 rounded-full blur-3xl" style={{ background: "radial-gradient(circle, rgba(47,116,255,0.40), rgba(2,6,23,0))" }} />
        <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-20 h-80 w-80 rounded-full blur-3xl" style={{ background: "radial-gradient(circle, rgba(124,58,237,0.28), rgba(2,6,23,0))" }} />
        <div className="relative grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-brand-200"><ShieldIcon /> Seguridad de nivel empresa</span>
            <h2 className="mt-5 text-3xl font-semibold tracking-tight text-white sm:text-[2.75rem] sm:leading-[1.05]">Tu data y la de tus clientes, protegidas de verdad.</h2>
            <p className="mt-5 max-w-md text-slate-300">No es una promesa de marketing. El aislamiento entre tiendas se aplica en la base de datos y las credenciales se cifran. Pensado para operar decenas de tiendas de distintos dueños sin que una vea a la otra.</p>
            <div className="mt-7 flex flex-wrap gap-2">
              {["AES-256-GCM", "Row Level Security", "HMAC en webhooks", "Tokens server-only"].map((t) => (
                <span key={t} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-slate-200">{t}</span>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            {points.map(([h, b]) => (
              <div key={h} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-400"><CheckIcon className="scale-90" /></span>
                  <div><p className="text-sm font-semibold text-white">{h}</p><p className="mt-1 text-[13px] leading-relaxed text-slate-400">{b}</p></div>
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
    ["Vende con datos", "Backfill inicial + sincronización continua. Tu panel se llena solo y la recuperación arranca sola."],
  ];
  return (
    <section id="como" className="mx-auto max-w-6xl px-5 py-20 scroll-mt-20 sm:py-24">
      <SectionHeading eyebrow="CÓMO FUNCIONA" title="En marcha en 3 pasos, en menos de 5 minutos" />
      <div className="mt-14 grid gap-6 sm:grid-cols-3">
        {steps.map(([title, body], i) => (
          <div key={title} className="relative rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 place-items-center rounded-full bg-brand-600 text-sm font-bold text-white tabular-nums">{i + 1}</span>
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
    ["¿De verdad llego al 20% de conversión?", "Es la tasa chat → venta que alcanzan las tiendas mejor operadas del canal WhatsApp. Kapso Sales te da las métricas, la recuperación y la clasificación de leads para llegar ahí — y te muestra exactamente dónde estás hoy."],
    ["¿Recupera carritos y clientes perdidos?", "Sí. Tres flujos automáticos por WhatsApp: carritos abandonados, búsquedas abandonadas (vía Shopify Flow) y winback de clientes con ~60 días sin comprar."],
    ["¿Lo puede usar todo mi equipo?", "Sí. Es multi-asesor y multi-admin, con roles y permisos (owner, admin, asesora, viewer). Cada quien ve solo lo suyo y mides la productividad por persona."],
    ["¿Usa inteligencia artificial?", "Sí. Lee los vouchers de Yape con la visión de Claude para confirmar pagos, y se conecta con Claude vía MCP para que consultes tus datos en lenguaje natural."],
    ["¿Mi data se mezcla con la de otras tiendas?", "No. Cada dueño tiene su propio espacio y la base de datos filtra cada consulta por tienda (Row Level Security). Es imposible ver la data de otro, incluso por error."],
    ["¿Necesito instalar o programar algo?", "No. Entras con Google, pegas tus credenciales de Shopify y Kapso, y listo. Nosotros registramos los webhooks y hacemos la sincronización."],
  ];
  return (
    <section id="faq" className="border-y border-slate-100 bg-slate-50/50 scroll-mt-20">
      <div className="mx-auto max-w-3xl px-5 py-20 sm:py-24">
        <SectionHeading eyebrow="PREGUNTAS FRECUENTES" title="Lo que probablemente te estás preguntando" />
        <div className="mt-12 divide-y divide-slate-200">
          {qa.map(([q, a]) => (
            <div key={q} className="py-5">
              <p className="flex items-start gap-2 text-[15px] font-semibold text-slate-900"><span className="text-brand-600">Q.</span> {q}</p>
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
      <div className="relative overflow-hidden rounded-[2rem] px-6 py-16 text-center sm:px-12 sm:py-20" style={{ background: "linear-gradient(135deg, #1b4fbd 0%, #2f74ff 50%, #7c3aed 130%)" }}>
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-40" style={{ background: "radial-gradient(40% 60% at 78% 18%, rgba(255,255,255,0.35), rgba(255,255,255,0))" }} />
        <div className="relative">
          <h2 className="mx-auto max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-[2.75rem] sm:leading-[1.05]">Empieza a vender más por WhatsApp hoy.</h2>
          <p className="mx-auto mt-4 max-w-xl text-brand-50/90">Crea tu cuenta gratis, conecta tu tienda en minutos y deja que la recuperación y la IA trabajen por ti.</p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/signup" className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-7 py-3.5 text-sm font-semibold text-brand-700 shadow-lg transition hover:bg-brand-50 sm:w-auto">Crea tu cuenta gratis <ArrowIcon /></Link>
            <Link href="/login" className="inline-flex w-full items-center justify-center rounded-xl border border-white/30 px-7 py-3.5 text-sm font-semibold text-white transition hover:bg-white/10 sm:w-auto">Iniciar sesión</Link>
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
            <div className="flex items-center gap-2.5"><Logo /><span className="text-[15px] font-semibold tracking-tight">Kapso Sales</span></div>
            <p className="mt-3 text-sm text-slate-500">Ventas, recuperación e IA para tiendas que venden por WhatsApp. Shopify + Kapso + Claude, en una pantalla.</p>
          </div>
          <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
            <FooterCol title="Producto" links={[["Métricas", "#producto"], ["Recuperación", "#recuperacion"], ["Equipo & IA", "#equipo"], ["Seguridad", "#seguridad"]]} />
            <FooterCol title="Recursos" links={[["Cómo funciona", "#como"], ["Preguntas", "#faq"], ["Iniciar sesión", "/login"]]} />
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
        {links.map(([label, href]) => (<li key={label}><a href={href} className="text-sm text-slate-600 transition hover:text-slate-900">{label}</a></li>))}
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
    <span className={`grid ${s} place-items-center rounded-lg text-white shadow-sm`} style={{ background: "linear-gradient(135deg, #1f5fe0, #2f74ff)" }} aria-hidden>
      <svg width={sm ? 13 : 16} height={sm ? 13 : 16} viewBox="0 0 24 24" fill="none"><path d="M4 15l4-5 4 3 4-7 4 5" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </span>
  );
}
function ClaudeMark({ big = false }: { big?: boolean }) {
  const s = big ? 22 : 16;
  // Anthropic-style burst mark, in Claude coral.
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden style={{ color: "#D97757" }}>
      {Array.from({ length: 12 }).map((_, i) => {
        const a = (i * Math.PI) / 6;
        const x1 = 12 + Math.cos(a) * 3.4, y1 = 12 + Math.sin(a) * 3.4;
        const x2 = 12 + Math.cos(a) * 10, y2 = 12 + Math.sin(a) * 10;
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />;
      })}
    </svg>
  );
}
function ArrowIcon() {
  return (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>);
}
function PlayIcon() {
  return (<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>);
}
function LockMini() {
  return (<svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden><rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="2" /><path d="M8 11V8a4 4 0 018 0v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>);
}
function ChartIcon() {
  return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M4 19V5M4 19h16M8 16v-4M12 16V8M16 16v-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>);
}
function ChatIcon() {
  return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H9l-4 4V6z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>);
}
function FunnelIcon() {
  return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M4 5h16l-6 7v6l-4 2v-8L4 5z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>);
}
function TargetIcon() {
  return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" /><circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="2" /></svg>);
}
function RefreshIcon() {
  return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M4 12a8 8 0 0113-6l2 2M20 12a8 8 0 01-13 6l-2-2M18 4v4h-4M6 20v-4h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>);
}
function CartIcon() {
  return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M3 4h2l2.5 12h10l2-8H6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><circle cx="9" cy="20" r="1.4" fill="currentColor" /><circle cx="17" cy="20" r="1.4" fill="currentColor" /></svg>);
}
function SearchIcon() {
  return (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden><circle cx="11" cy="11" r="6" stroke="currentColor" strokeWidth="2" /><path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>);
}
function TelegramIcon() {
  return (<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M21.9 4.3l-3.3 15.6c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-4.9 8.9-8c.4-.3-.1-.5-.6-.2L6.2 13.6l-4.7-1.5c-1-.3-1-1 .2-1.5L20.6 2.9c.8-.3 1.5.2 1.3 1.4z" /></svg>);
}
function ShieldIcon() {
  return (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>);
}
function CheckIcon({ className = "" }: { className?: string }) {
  return (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden className={className}><path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>);
}
function CrossIcon() {
  return (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden className="mt-0.5 shrink-0 text-slate-300"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>);
}
