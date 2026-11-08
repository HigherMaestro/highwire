// Solve "Duels" tug-of-war (simultaneous all-pay bids, budgets) by backward induction.
// Assumes full information about state (both energies, position) each round.
const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')).map(([k, v]) => [k, Number(v)]));
const E0 = args.E ?? 30, R = args.R ?? 15, D = args.D ?? 3, REGEN = args.regen ?? 0, MINPULL = args.min ?? 0;
const P = 2 * D - 1; // interior positions -(D-1)..(D-1)

// Solve zero-sum game: row maximizes. Returns {v, x, y}.
function solve(A) {
  const m = A.length, n = A[0].length;
  // quick saddle check
  let lo = -Infinity, hi = Infinity, ri = 0, cj = 0;
  for (let i = 0; i < m; i++) { let mn = Infinity; for (let j = 0; j < n; j++) mn = Math.min(mn, A[i][j]); if (mn > lo) { lo = mn; ri = i; } }
  for (let j = 0; j < n; j++) { let mx = -Infinity; for (let i = 0; i < m; i++) mx = Math.max(mx, A[i][j]); if (mx < hi) { hi = mx; cj = j; } }
  if (hi - lo < 1e-12) { const x = new Array(m).fill(0), y = new Array(n).fill(0); x[ri] = 1; y[cj] = 1; return { v: lo, x, y }; }
  // LP: max sum y s.t. B y <= 1, y>=0, B = A + shift > 0
  const s = 3;
  const T = []; // m rows: [B | I | rhs]
  for (let i = 0; i < m; i++) { const row = new Float64Array(n + m + 1); for (let j = 0; j < n; j++) row[j] = A[i][j] + s; row[n + i] = 1; row[n + m] = 1; T.push(row); }
  const obj = new Float64Array(n + m + 1); for (let j = 0; j < n; j++) obj[j] = -1;
  const basis = []; for (let i = 0; i < m; i++) basis.push(n + i);
  for (let it = 0; it < 10000; it++) {
    let pc = -1, best = -1e-12;
    for (let j = 0; j < n + m; j++) if (obj[j] < best) { best = obj[j]; pc = j; }
    if (pc < 0) break;
    let pr = -1, br = Infinity;
    for (let i = 0; i < m; i++) if (T[i][pc] > 1e-12) { const r = T[i][n + m] / T[i][pc]; if (r < br - 1e-15) { br = r; pr = i; } }
    if (pr < 0) throw new Error('unbounded');
    const pv = T[pr][pc]; const prow = T[pr];
    for (let k = 0; k <= n + m; k++) prow[k] /= pv;
    for (let i = 0; i < m; i++) if (i !== pr) { const f = T[i][pc]; if (f !== 0) { const row = T[i]; for (let k = 0; k <= n + m; k++) row[k] -= f * prow[k]; } }
    const f = obj[pc]; for (let k = 0; k <= n + m; k++) obj[k] -= f * prow[k];
    basis[pr] = pc;
  }
  const opt = obj[n + m];
  const y = new Array(n).fill(0); for (let i = 0; i < m; i++) if (basis[i] < n) y[basis[i]] = T[i][n + m] / opt;
  const x = new Array(m); for (let i = 0; i < m; i++) x[i] = obj[n + i] / opt;
  return { v: 1 / opt - s, x, y };
}

const idx = (r, p, a, b) => ((r * P + (p + D - 1)) * (E0 + 1) + a) * (E0 + 1) + b;
const N = (R + 2) * P * (E0 + 1) * (E0 + 1);
const V = new Float64Array(N);
const SX = new Array(N), SY = new Array(N);
const terminalPos = p => (p >= D ? 1 : p <= -D ? -1 : null);
function bids(e) { const out = []; for (let k = 0; k <= e; k++) if ((k === 0 && e === 0) || (k >= MINPULL) || k === e) out.push(k); return out; }
function next(r, p, a, b, i, j) {
  const np = p + Math.sign(i - j);
  const t = terminalPos(np); if (t !== null) return t;
  const na = Math.min(E0, a - i + REGEN), nb = Math.min(E0, b - j + REGEN);
  if (r + 1 >= R || (na === 0 && nb === 0 && REGEN === 0)) return Math.sign(np);
  return V[idx(r + 1, np, na, nb)];
}
const t0 = Date.now();
for (let r = R - 1; r >= 0; r--) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E0; a++) for (let b = 0; b <= E0; b++) {
  const bi = bids(a), bj = bids(b);
  const A = bi.map(i => bj.map(j => next(r, p, a, b, i, j)));
  const { v, x, y } = solve(A);
  const k = idx(r, p, a, b); V[k] = v; SX[k] = x; SY[k] = y;
}
const solveMs = Date.now() - t0;

// forward: outcome distribution under given strategy fns
function play(stratA, stratB) {
  let dist = new Map([[idx(0, 0, E0, E0), 1]]);
  let live = 0, win = 0, loss = 0, draw = 0, len = 0, zeroBidMass = 0, bidMass = 0, firstBidDecisive = 0;
  for (let r = 0; r < R; r++) {
    const nd = new Map();
    for (const [k, pr] of dist) {
      if (Math.abs(V[k]) < 0.999) live += pr;
      const b0 = k % (E0 + 1), a0 = Math.floor(k / (E0 + 1)) % (E0 + 1), p = Math.floor(k / (E0 + 1) ** 2) % P - (D - 1);
      if (a0 === 0 && b0 === 0 && REGEN === 0) { const s = Math.sign(p); if (s > 0) win += pr; else if (s < 0) loss += pr; else draw += pr; len += pr * r; continue; }
      const bi = bids(a0), bj = bids(b0);
      const x = stratA(r, p, a0, b0, bi), y = stratB(r, p, a0, b0, bj);
      for (let ii = 0; ii < bi.length; ii++) { if (x[ii] < 1e-12) continue; if (bi[ii] === 0) zeroBidMass += pr * x[ii]; bidMass += pr * x[ii];
        for (let jj = 0; jj < bj.length; jj++) { if (y[jj] < 1e-12) continue;
          const q = pr * x[ii] * y[jj], i = bi[ii], j = bj[jj];
          const np = p + Math.sign(i - j);
          if (np >= D) { win += q; len += q * (r + 1); continue; } if (np <= -D) { loss += q; len += q * (r + 1); continue; }
          const na = Math.min(E0, a0 - i + REGEN), nb = Math.min(E0, b0 - j + REGEN);
          if (r + 1 >= R) { const s = Math.sign(np); if (s > 0) win += q; else if (s < 0) loss += q; else draw += q; len += q * (r + 1); continue; }
          const nk = idx(r + 1, np, na, nb); nd.set(nk, (nd.get(nk) ?? 0) + q);
        } }
    }
    dist = nd;
  }
  return { win, loss, draw, len, live, zeroShare: zeroBidMass / bidMass };
}
const eqA = (r, p, a, b) => SX[idx(r, p, a, b)];
const eqB = (r, p, a, b) => SY[idx(r, p, a, b)];
const pure = f => (r, p, a, b, bs) => { const want = f(r, p, a, b); let best = 0; for (let k = 0; k < bs.length; k++) if (Math.abs(bs[k] - want) < Math.abs(bs[best] - want)) best = k; const out = bs.map(() => 0); out[best] = 1; return out; };
// heuristics from B's perspective: B's own energy is b, opponent's a, position from B's view is -p
const H = {
  zero: pure(() => 0),
  allin: pure((r, p, a, b) => b),
  const2: pure((r, p, a, b) => Math.min(b, 2)),
  pace: pure((r, p, a, b) => Math.floor(b / (R - r))),
  pace_plus1: pure((r, p, a, b) => Math.min(b, Math.floor(b / (R - r)) + 1)),
  outbid_last: null,
  third: pure((r, p, a, b) => Math.ceil(b / 3)),
  match_opp_plus1: pure((r, p, a, b) => Math.min(b, Math.floor(a / (R - r)) + 1)),
};
delete H.outbid_last;
// best response by A against fixed B strategy
function bestResponse(stratB) {
  const W = new Float64Array(N);
  const nx = (r, p, a, b, i, j) => { const np = p + Math.sign(i - j); const t = terminalPos(np); if (t !== null) return t; const na = Math.min(E0, a - i + REGEN), nb = Math.min(E0, b - j + REGEN); if (r + 1 >= R || (na === 0 && nb === 0 && REGEN === 0)) return Math.sign(np); return W[idx(r + 1, np, na, nb)]; };
  for (let r = R - 1; r >= 0; r--) for (let p = -(D - 1); p <= D - 1; p++) for (let a = 0; a <= E0; a++) for (let b = 0; b <= E0; b++) {
    const bi = bids(a), bj = bids(b); const y = stratB(r, p, a, b, bj); let best = -Infinity;
    for (const i of bi) { let s = 0; for (let jj = 0; jj < bj.length; jj++) if (y[jj] > 0) s += y[jj] * nx(r, p, a, b, i, bj[jj]); best = Math.max(best, s); }
    W[idx(r, p, a, b)] = best;
  }
  return W[idx(0, 0, E0, E0)];
}
const fmt = n => n.toFixed(3);
console.log(`params E=${E0} R=${R} D=${D} regen=${REGEN} min=${MINPULL}; solved in ${solveMs} ms; V(start)=${fmt(V[idx(0, 0, E0, E0)])}`);
const eq = play(eqA, eqB);
console.log(`eq vs eq: win ${fmt(eq.win)} loss ${fmt(eq.loss)} draw ${fmt(eq.draw)} avg rounds ${fmt(eq.len)} avg rounds still undecided ${fmt(eq.live)} V(r2,pos+1,equal E)=${fmt(V[idx(1,1,E0-3,E0-3)])} share of zero pulls ${fmt(eq.zeroShare)}`);
const open = SX[idx(0, 0, E0, E0)].map((w, k) => [bids(E0)[k], w]).filter(([, w]) => w > 1e-4).map(([b, w]) => `${b}:${w.toFixed(3)}`).join(' ');
console.log(`opening mix: ${open}`);
for (const p of [1, -1]) { const s = SX[idx(1, p, E0 - 3, E0 - 3)]; if (s) console.log(`round2 pos ${p} energies ${E0 - 3}/${E0 - 3}: ` + s.map((w, k) => [bids(E0 - 3)[k], w]).filter(([, w]) => w > 1e-3).map(([b, w]) => `${b}:${w.toFixed(2)}`).join(' ')); }
for (const [name, h] of Object.entries(H)) {
  const vsEq = play(eqA, h);
  const br = bestResponse(h);
  console.log(`${name.padEnd(16)} eq vs it: W ${fmt(vsEq.win)} L ${fmt(vsEq.loss)} D ${fmt(vsEq.draw)} | best-response score vs it ${fmt(br)}`);
}
// heuristic round robin (A = row heuristic)
const names = Object.keys(H);
const hA = f => f; // heuristics are written from B's view; build A versions by mirroring
const mirror = h => (r, p, a, b, bs) => h(r, -p, b, a, bs);
console.log('round robin (row as A, expected score W-L):');
for (const n1 of names) console.log(n1.padEnd(16) + names.map(n2 => { const g = play(mirror(H[n1]), H[n2]); return (g.win - g.loss).toFixed(2).padStart(6); }).join(''));
console.log(`exploitability check: best response vs eqB = ${fmt(bestResponse(eqB))} (should equal V(start))`);
const show = (r, p, a, b) => { const k = idx(r, p, a, b); const s = SX[k]; console.log(`state r=${r + 1} pos=${p} myE=${a} oppE=${b}: V=${fmt(V[k])} mix ` + s.map((w, i) => [bids(a)[i], w]).filter(([, w]) => w > 1e-3).map(([x, w]) => `${x}:${w.toFixed(2)}`).join(' ')); };
show(4, -2, 15, 15); show(4, 2, 15, 15); show(4, 0, 10, 25); show(4, 0, 25, 10); show(4, -1, 20, 12); show(12, 0, 5, 5); show(12, 1, 3, 9);

{ const x = SX[idx(0,0,E0,E0)], y = SY[idx(0,0,E0,E0)], bs = bids(E0); let m = 0, w = 0;
  for (let i = 0; i < bs.length; i++) for (let j = 0; j < bs.length; j++) if (bs[i] > bs[j]) { const q = x[i]*y[j]; m += q; const n = next(0,0,E0,E0,bs[i],bs[j]); w += q*(1+n)/2; }
  console.log(`P(round-1 winner goes on to win, draws as half) = ${fmt(w/m)}; P(round 1 tied) = ${fmt(1-2*m)}`); }
