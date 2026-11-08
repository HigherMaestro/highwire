"use client";

import { useState } from "react";

// Share a fee page: a post on X with the page's numbers and its link (which previews as the page's own card), or the
// link copied. Nothing loads from X until someone clicks.

export function ShareLinks({ url, text }: { url: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const intent = `https://x.com/intent/post?${new URLSearchParams({ text, url })}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (an insecure context or a refused permission): the link is in the address bar anyway.
    }
  }
  return (
    <div className="fee-share">
      <a className="button" href={intent} target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path fill="currentColor" d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.17h1.7L7.4 4.74H5.58l11.1 14.43Z" />
        </svg>
        Share on X
      </a>
      <button type="button" className="button button-quiet" onClick={copy} aria-live="polite">
        {copied ? "Link copied" : "Copy link"}
      </button>
    </div>
  );
}
