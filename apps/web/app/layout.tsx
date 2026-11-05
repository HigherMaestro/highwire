import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import type { ReactNode } from "react";
import { SITE_URL, X_HANDLE } from "../lib/site.ts";
import "./globals.css";

const grotesk = Space_Grotesk({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-grotesk" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["500"], variable: "--font-mono" });

const description =
  "Highwire is an MCP server that lets AI agents scan launches, research coins and creators, and run rug checks on higher.fun, the open-source Solana launchpad.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: "Highwire, the agent wire for higher.fun", template: "%s · Highwire" },
  description,
  openGraph: { type: "website", url: SITE_URL, siteName: "Highwire", title: "Highwire, the agent wire for higher.fun", description },
  twitter: {
    card: "summary_large_image",
    site: X_HANDLE,
    creator: X_HANDLE,
    title: "Highwire, the agent wire for higher.fun",
    description,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F4EE" },
    { media: "(prefers-color-scheme: dark)", color: "#0E1116" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${grotesk.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
