import { listModules, moduleMarkdown } from "../../../../lib/ideas.ts";

// The module's spec and every file as one markdown page, for coding agents to fetch.

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return listModules().map((m) => ({ slug: m.slug }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(moduleMarkdown(slug), { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
