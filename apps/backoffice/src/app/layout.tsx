import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  description: "Aplicação operacional separada da Set Livre.",
  robots: { follow: false, index: false },
  title: "Backoffice · Set Livre",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { color: "#eaf0ec", media: "(prefers-color-scheme: light)" },
    { color: "#0e1914", media: "(prefers-color-scheme: dark)" },
  ],
  viewportFit: "cover",
  width: "device-width",
};

export default async function BackofficeLayout({ children }: Readonly<{ children: ReactNode }>) {
  await connection();

  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
