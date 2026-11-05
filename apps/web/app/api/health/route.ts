import { VERSION } from "highwire-mcp";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, name: "highwire", version: VERSION });
}
