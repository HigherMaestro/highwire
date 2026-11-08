// Glicko-2 (Glickman, "Example of the Glicko-2 system", 2013): a rating, its deviation (how sure we are) and its
// volatility, updated after each match as a rating period of one game. The arena starts fighters at 1500 / 350 / 0.06
// with tau 0.5 (docs/arena.md 7), and ranks by the conservative r - 2·RD.

export interface Rating {
  r: number;
  rd: number;
  vol: number;
}

export const START: Rating = { r: 1500, rd: 350, vol: 0.06 };
export const TAU = 0.5;
/** A fighter is provisional while its deviation is at least this. */
export const PROVISIONAL_RD = 110;

const SCALE = 173.7178;

/** One game's result against an opponent: 1 a win, 0.5 a draw, 0 a loss; `weight` scales how much it counts (0 to 1). */
export interface Game {
  opponent: Rating;
  score: 0 | 0.5 | 1;
  weight?: number;
}

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));

/**
 * The rating after a rating period with these games (none: only the deviation grows). A game's `weight` multiplies its
 * information, so a quarter-weight win moves the rating about a quarter as far.
 */
export function rate(player: Rating, games: Game[], tau = TAU): Rating {
  const mu = (player.r - 1500) / SCALE;
  const phi = player.rd / SCALE;
  if (!games.length) return { ...player, rd: Math.min(350, Math.sqrt(phi * phi + player.vol * player.vol) * SCALE) };

  let vInv = 0;
  let sum = 0;
  for (const game of games) {
    const w = game.weight ?? 1;
    const muJ = (game.opponent.r - 1500) / SCALE;
    const gJ = g(game.opponent.rd / SCALE);
    const e = 1 / (1 + Math.exp(-gJ * (mu - muJ)));
    vInv += w * gJ * gJ * e * (1 - e);
    sum += w * gJ * (game.score - e);
  }
  if (vInv === 0) return { ...player };
  const v = 1 / vInv;
  const delta = v * sum;

  // The new volatility: Illinois's method on f(x), as in step 5 of the paper.
  const a = Math.log(player.vol * player.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * tau) < 0) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const vol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * sum;
  return { r: muNew * SCALE + 1500, rd: phiNew * SCALE, vol };
}

/** The leaderboard's number: a rating we're fairly sure the fighter is at least. */
export const conservative = (x: Rating) => x.r - 2 * x.rd;
