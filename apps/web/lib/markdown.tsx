import type { ReactNode } from "react";

// Just enough Markdown for CHANGELOG.md and the ideas' PRDs: ## and ###
// headings, paragraphs, "- " and "1. " lists (with indented continuation
// lines), fenced code blocks, `code`, **bold** and [links](url). Builds React
// nodes, never raw HTML.

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1] !== undefined) out.push(<code key={k}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k}>{inline(m[2], k)}</strong>);
    else if (/^(https:\/\/|\/|#)/.test(m[4]!)) out.push(<a key={k} href={m[4]}>{m[3]}</a>);
    else out.push(m[3]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Renders the subset above. A leading "# " title is skipped: the page has its own h1. */
export function Markdown({ source }: { source: string }) {
  const blocks: ReactNode[] = [];
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: string[] = [];
  let ordered = false;
  let code: string[] | null = null;
  const flush = () => {
    const k = `b${blocks.length}`;
    if (para.length) blocks.push(<p key={k}>{inline(para.join(" "), k)}</p>);
    if (list.length) {
      const items = list.map((item, j) => <li key={j}>{inline(item, `${k}-${j}`)}</li>);
      blocks.push(ordered ? <ol key={`${k}l`}>{items}</ol> : <ul key={`${k}l`}>{items}</ul>);
    }
    para = [];
    list = [];
  };
  for (const line of lines) {
    if (code) {
      if (/^```/.test(line)) {
        blocks.push(
          <pre key={`c${blocks.length}`}>
            <code>{code.join("\n")}</code>
          </pre>,
        );
        code = null;
      } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) {
      flush();
      code = [];
      continue;
    }
    if (/^# /.test(line)) continue;
    const h = /^(#{2,3}) (.*)$/.exec(line);
    if (h) {
      flush();
      const text = h[2]!;
      const k = `h${blocks.length}`;
      blocks.push(
        h[1] === "##" ? (
          <h2 key={k} id={slug(text)}>
            {inline(text, k)}
          </h2>
        ) : (
          <h3 key={k}>{inline(text, k)}</h3>
        ),
      );
    } else if (/^(- |\d+\. )/.test(line)) {
      const isOrdered = !line.startsWith("- ");
      if (para.length || (list.length && isOrdered !== ordered)) flush();
      ordered = isOrdered;
      list.push(line.replace(/^(- |\d+\. )/, ""));
    } else if (/^\s+\S/.test(line) && list.length) {
      list[list.length - 1] += ` ${line.trim()}`;
    } else if (line.trim() === "") {
      flush();
    } else {
      if (list.length) flush();
      para.push(line.trim());
    }
  }
  flush();
  return <>{blocks}</>;
}
