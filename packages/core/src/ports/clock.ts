/** Time, injected so plans wait on observed conditions with budgets and tests never sleep. Adapter: packages/node. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Resolves after `ms`. Plans use it between observations, never as the success condition. */
  sleep(ms: number): Promise<void>;
}
