// The H monogram from brand/: two posts with the wire sagging between them.
// Posts follow currentColor so the mark flips with dark mode.

const STOPS: [number, string][] = [
  [0, "#F7C84C"],
  [0.35, "#F6A9C4"],
  [0.7, "#93E2FB"],
  [1, "#A6EFCB"],
];

const WIRE = "M32 46 Q60 76 88 46";

export function Mark({
  id,
  size = 40,
  heavy = false,
  animated = false,
  label,
}: {
  id: string;
  size?: number;
  heavy?: boolean;
  animated?: boolean;
  label?: string;
}) {
  const post = heavy ? 17 : 11;
  const wire = heavy ? 9 : 6;
  const node = heavy ? 8 : 6.5;
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} className="mark" {...a11y}>
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="32" y1="0" x2="88" y2="0">
          {STOPS.map(([o, c]) => (
            <stop key={o} offset={o} stopColor={c} />
          ))}
        </linearGradient>
      </defs>
      <line x1="32" y1="24" x2="32" y2="96" stroke="currentColor" strokeWidth={post} strokeLinecap="round" />
      <line x1="88" y1="24" x2="88" y2="96" stroke="currentColor" strokeWidth={post} strokeLinecap="round" />
      <path d={WIRE} fill="none" stroke={`url(#${id})`} strokeWidth={wire} strokeLinecap="round" />
      <circle className={animated ? "node node-static" : "node"} cx="60" cy="61" r={node} strokeWidth="3" />
      {animated ? (
        <circle className="node node-moving" r={node} strokeWidth="3">
          <animateMotion
            dur="9s"
            repeatCount="indefinite"
            path={WIRE}
            keyPoints="0.5;0.18;0.82;0.5"
            keyTimes="0;0.3;0.75;1"
            calcMode="spline"
            keySplines="0.45 0 0.55 1;0.45 0 0.55 1;0.45 0 0.55 1"
          />
        </circle>
      ) : null}
    </svg>
  );
}

export function Lockup({ id }: { id: string }) {
  return (
    <span className="lockup">
      <Mark id={id} size={34} heavy label="Highwire" />
      <span className="lockup-word" aria-hidden="true">
        highwire
      </span>
    </span>
  );
}
