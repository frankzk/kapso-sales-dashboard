import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kapso Sales Dashboard",
  description: "Panel de ventas multi-tienda para bots de WhatsApp (Kapso → Shopify)",
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
