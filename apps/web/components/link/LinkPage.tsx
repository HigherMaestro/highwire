import type { ReactNode } from "react";
import { SiteFooter, SiteHeader } from "../Chrome.tsx";
import { PreviewNote } from "../arena/Parts.tsx";

// A link battle's page frame (the battle, a turn, a practice): the stage is the page. Above it, one line: where this is
// (a link back) and what it is, in a sentence a stranger can read in a second. The page's heading is there for screen
// readers; the scorebar shows both names. Then the stage, and the rest a click away.

export function LinkPage({ crumbs, title, strap, preview, children, about }: { crumbs: ReactNode; title: string; strap: string; preview: boolean; children: ReactNode; about: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main className="arena link-page">
        <div className="wrap link-page-top">
          <h1 className="sr-only">{title}</h1>
          <p className="link-strap">
            <span className="link-crumbs">{crumbs}</span>
            <span className="link-strap-text">{strap}</span>
          </p>
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
