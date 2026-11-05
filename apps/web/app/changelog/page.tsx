import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../../components/Chrome.tsx";
import { Markdown } from "../../lib/markdown.tsx";

export const metadata: Metadata = {
  title: "Changelog",
  description: "Every Highwire release: the MCP server, highwire-core and the site.",
  alternates: { canonical: "/changelog" },
};

/** The repo's CHANGELOG.md, read at build time. `next` runs from apps/web. */
function changelog(): string {
  return readFileSync(join(process.cwd(), "../../CHANGELOG.md"), "utf8");
}

export default function ChangelogPage() {
  return (
    <>
      <SiteHeader />
      <main className="prose-page">
        <div className="wrap">
          <article className="prose">
            <p className="eyebrow">Changelog</p>
            <h1>What changed</h1>
            <Markdown source={changelog()} />
          </article>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
