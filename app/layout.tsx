import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kapso Sales Dashboard",
  description: "Panel de ventas multi-tienda para bots de WhatsApp (Kapso → Shopify)",
};

// `viewport-fit=cover` deja que la página use `env(safe-area-inset-*)`: sin
// él, en un teléfono con muesca o barra de inicio los paneles a pantalla
// completa terminan debajo de la barra y el último botón no se alcanza.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
