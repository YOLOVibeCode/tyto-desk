import type { HostChannel } from "../ports/host-channel.ts";
import type { HostConnector } from "../ports/host-connector.ts";

/** A native-messaging connection the test plays the host's end of. */
export class FakeHostChannel implements HostChannel {
  readonly posted: unknown[] = [];
  closed = false;
  private readonly messageListeners: ((message: unknown) => void)[] = [];
  private readonly disconnectListeners: ((error: string | null) => void)[] = [];

  post(message: unknown): void {
    if (this.closed) throw new Error("posted to a closed channel");
    this.posted.push(message);
  }

  onMessage(listener: (message: unknown) => void): void {
    this.messageListeners.push(listener);
  }

  onDisconnect(listener: (error: string | null) => void): void {
    this.disconnectListeners.push(listener);
  }

  disconnect(): void {
    this.closed = true;
  }

  /** The host sends `message`. */
  deliver(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }

  /** The host goes away. */
  drop(error: string | null = "Native host has exited."): void {
    this.closed = true;
    for (const listener of this.disconnectListeners) listener(error);
  }
}

/** Records every connection it opens. */
export class FakeHostConnector implements HostConnector {
  readonly channels: FakeHostChannel[] = [];

  open(): FakeHostChannel {
    const channel = new FakeHostChannel();
    this.channels.push(channel);
    return channel;
  }

  /** The latest connection, failing the test when there is none. */
  last(): FakeHostChannel {
    const channel = this.channels.at(-1);
    if (channel === undefined) throw new Error("no host connection was opened");
    return channel;
  }
}
