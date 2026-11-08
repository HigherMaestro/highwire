// Time, injected: the referee's clocks and long-polls run on it, so tests can move time instead of waiting.

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A clock that only moves when told to; `sleep` moves it. */
export class FakeClock implements Clock {
  constructor(public t = Date.UTC(2026, 10, 9, 12)) {}
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
  }
  advance(ms: number) {
    this.t += ms;
  }
}
