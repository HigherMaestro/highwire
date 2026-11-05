"use client";

import { useState } from "react";

export function CopyCommand({ code, label, multiline = false }: { code: string; label: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={multiline ? "copy copy-block" : "copy"}>
      <pre className="copy-code" tabIndex={0} aria-label={label}>
        <code>{code}</code>
      </pre>
      <button type="button" className="copy-button" onClick={copy} aria-label={`Copy: ${label}`}>
        {copied ? "Copied" : "Copy"}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </div>
  );
}
