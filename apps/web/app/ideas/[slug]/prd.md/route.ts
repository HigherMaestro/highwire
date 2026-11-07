import { listIdeas, readPrd } from "../../../../lib/ideas.ts";

// The idea's PRD as plain markdown, for agents to fetch.

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return listIdeas().map((i) => ({ slug: i.slug }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return new Response(readPrd(slug), { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
