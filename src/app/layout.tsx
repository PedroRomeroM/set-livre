import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { readProfilePreferenceCookie } from "@/domains/identity/server/profile-preference-cookie";

import "./globals.css";
import { ApplicationProviders } from "./providers";

export const metadata: Metadata = {
  description: "Marketplace de aluguel de estúdios audiovisuais.",
  title: {
    default: "Set Livre",
    template: "%s · Set Livre",
  },
};

export async function generateViewport(): Promise<Viewport> {
  const preference = await readProfilePreferenceCookie();
  const themeColor =
    preference === "system"
      ? [
          { color: "#eaf0ec", media: "(prefers-color-scheme: light)" },
          { color: "#0e1914", media: "(prefers-color-scheme: dark)" },
        ]
      : preference === "dark"
        ? "#0e1914"
        : "#eaf0ec";
  return {
    colorScheme: "light dark",
    themeColor,
    viewportFit: "cover",
    width: "device-width",
  };
}

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  await connection();
  const colorScheme = await readProfilePreferenceCookie();

  return (
    <html data-color-scheme={colorScheme} lang="pt-BR">
      <body>
        <ApplicationProviders>{children}</ApplicationProviders>
      </body>
    </html>
  );
}
