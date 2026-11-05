"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { usePathname } from "next/navigation";

const isSign = (path: string) => path === "/sign" || path.startsWith("/sign/");

/** Drops anything about the sign page, and strips the query and fragment (a sign link carries its transaction there). */
function beforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  const url = new URL(event.url);
  if (isSign(url.pathname)) return null;
  url.search = "";
  url.hash = "";
  return { ...event, url: url.toString() };
}

/**
 * Vercel Web Analytics for every page but /sign, which must not load third-party scripts or report anywhere (its CSP
 * blocks it anyway). beforeSend covers a visitor who reaches /sign by client-side navigation after the script loaded.
 */
export function SiteAnalytics() {
  const pathname = usePathname();
  if (isSign(pathname)) return null;
  return <Analytics beforeSend={beforeSend} />;
}
