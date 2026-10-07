import type { ProcessSignals } from "../ports/process-signals.ts";

/** Records each pid it was asked to terminate; every one counts as ended. */
export class FakeProcessSignals implements ProcessSignals {
  readonly terminated: number[] = [];
  /** Runs after each terminate, as the ended process would act (a watch that releases its lock). */
  onTerminate: (pid: number) => void = () => undefined;
  private readonly log: string[];

  constructor(log: string[] = []) {
    this.log = log;
  }

  async terminate(pid: number): Promise<boolean> {
    this.terminated.push(pid);
    this.log.push(`signals.terminate ${pid}`);
    this.onTerminate(pid);
    return true;
  }
}
