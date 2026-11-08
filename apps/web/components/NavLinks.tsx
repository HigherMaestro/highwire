"use client";

import { usePathname } from "next/navigation";
import type { NavLink } from "./MobileMenu.tsx";

// The header's few page links, with the section you're in marked (aria-current), so the header doubles as a "you are
// here" sign.

export function NavLinks({ links }: { links: (NavLink & { match?: string[] })[] }) {
  const path = usePathname() ?? "/";
  return (
    <ul className="nav">
      {links.map((l) => {
        const here = (l.match ?? [l.href]).some((p) => path === p || path.startsWith(`${p}/`));
        return (
          <li key={l.href}>
            <a href={l.href} aria-current={here ? "page" : undefined}>
              {l.label}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
