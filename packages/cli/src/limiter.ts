// Spaces every outgoing request at least 1/N seconds after the one before, across all providers
// and all concurrent work, so the CLI never asks a free provider for more than N a second.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class RateLimiter {
  readonly #gapMs: number;
  readonly #clock: Clock;
  #next = 0;
  /** When each request was let through, for tests that check the rate. */
  readonly granted: number[] = [];

  constructor(perSecond: number, clock: Clock = realClock) {
    this.#gapMs = Math.ceil(1000 / perSecond);
    this.#clock = clock;
  }

  /** Resolves when the caller may send one request. Slots are handed out in call order. */
  async slot(): Promise<void> {
    const now = this.#clock.now();
    const at = Math.max(now, this.#next);
    this.#next = at + this.#gapMs;
    if (at > now) await this.#clock.sleep(at - now);
    this.granted.push(at);
  }
}
