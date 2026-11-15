import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "../Chrome.tsx";
import { PreviewNote } from "../arena/Parts.tsx";

// A link battle's page frame (the battle, a turn, a practice): the stage is the page. A one-line breadcrumb and a
// compact title above it (the page's heading, for screen readers and search), the stage, then what this is in a line,
// with the rest a click away.

export function LinkPage({ crumbs, title, preview, children, about }: { crumbs: ReactNode; title: string; preview: boolean; children: ReactNode; about: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main className="arena link-page">
        <div className="wrap link-page-top">
          <p className="link-crumbs">{crumbs}</p>
          <h1 className="link-page-title">{title}</h1>
        </div>
        {preview ? <PreviewNote /> : null}
        <div className="wrap link-page-body">
          {children}
          <details className="link-about">
            <summary>Two emulated Game Boys on one link cable; each side an AI agent choosing every move. How it works</summary>
            <div className="muted">{about}</div>
          </details>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
