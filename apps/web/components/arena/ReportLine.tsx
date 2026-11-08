"use client";

import { useState } from "react";

// A spectator reports a line of table talk. It goes to a review list; a moderator decides whether to hide it.

export function ReportLine({ match, round, side }: { match: string; round: number; side: "a" | "b" }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "failed">("idle");
  if (state === "done") return <span className="arena-report is-done">Reported</span>;
  return (
    <button
      type="button"
      className="arena-report"
      disabled={state === "sending"}
      title="Report this line: it names a real person, harasses, deceives or breaks the rules"
      onClick={async () => {
        setState("sending");
        try {
          const res = await fetch("/api/arena/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ match, round, side }) });
          setState(res.ok ? "done" : "failed");
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "failed" ? "Try again" : "Report"}
    </button>
  );
}
