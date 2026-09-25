import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type DHT from "hyperdht";
import {
  DHT_DIAL_MAX_ATTEMPTS,
  encodePeerInvite,
  encodePeerLanHintFrame,
} from "@getpaseo/protocol/dht-peer";
import { createDhtTransportFactory } from "./dht-transport.js";

// A dial-scriptable fake: each connect() consumes the next scripted outcome.
// Failed hyperdht dials end with the socket destroyed, so a scripted failure
// emits "close" after "error" — the ladder must not surface that close while
// it is retrying.
class FakeStream extends EventEmitter {
  write(): boolean {
    return true;
  }
  end(): void {
    setTimeout(() => this.emit("close"), 0);
  }
  destroy(): void {
    setTimeout(() => this.emit("close"), 0);
  }
}

type DialOutcome = "open" | { errorCode: string };

class FakeDHT {
  attempts = 0;
  destroyed = false;
  lastStream: FakeStream | null = null;
  readonly dialOptions: unknown[] = [];

  constructor(private readonly outcomes: readonly DialOutcome[]) {}

  connect(_publicKey: Uint8Array, options?: unknown): FakeStream {
    const outcome = this.outcomes[Math.min(this.attempts, this.outcomes.length - 1)]!;
    this.attempts += 1;
    this.dialOptions.push(options);
    const stream = new FakeStream();
    this.lastStream = stream;
    // Zero-delay timers (not microtasks) so vi.useFakeTimers drives the emits.
    setTimeout(() => {
      if (outcome === "open") {
        stream.emit("open");
        return;
      }
      const error = new Error(outcome.errorCode) as Error & { code: string };
      error.code = outcome.errorCode;
      stream.emit("error", error);
      setTimeout(() => stream.emit("close"), 0);
    }, 0);
    return stream;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

const INVITE = encodePeerInvite({ publicKey: new Uint8Array(32).fill(7) });

function factoryFor(dht: FakeDHT) {
  return createDhtTransportFactory({
    invite: INVITE,
    createDht: () => dht as unknown as DHT,
  });
}

function watch(transport: ReturnType<ReturnType<typeof factoryFor>>) {
  const events: string[] = [];
  transport.onOpen(() => events.push("open"));
  transport.onError(() => events.push("error"));
  transport.onClose(() => events.push("close"));
  return events;
}

describe("dht-transport dial ladder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("redials transient holepunch failures without surfacing error or close", async () => {
    const dht = new FakeDHT([
      { errorCode: "HOLEPUNCH_ABORTED" },
      { errorCode: "HOLEPUNCH_PROBE_TIMEOUT" },
      "open",
    ]);
    const events = watch(factoryFor(dht)());

    // The ladder's fake-time backoff (400+800ms before attempt 3) outlives
    // waitFor's 1s default budget.
    await vi.waitFor(() => expect(events).toContain("open"), { timeout: 10_000 });

    expect(dht.attempts).toBe(3);
    // The two failed attempts closed sockets underneath the dial; neither may
    // surface — the consumer only learns about the dial that mattered.
    expect(events).toEqual(["open"]);
  });

  it("surfaces the error once the ladder exhausts", async () => {
    const dht = new FakeDHT([{ errorCode: "HOLEPUNCH_ABORTED" }]);
    const events = watch(factoryFor(dht)());

    await vi.waitFor(() => expect(events).toContain("error"), { timeout: 10_000 });

    expect(dht.attempts).toBe(DHT_DIAL_MAX_ATTEMPTS);
    expect(events.filter((e) => e === "error")).toHaveLength(1);
    // The failed socket's close follows the error, as hyperdht destroys it.
    await vi.waitFor(() => expect(events).toContain("close"));
    expect(dht.destroyed).toBe(true);
  });

  it("does not retry refusals the network did not cause", async () => {
    const dht = new FakeDHT([{ errorCode: "SERVER_ERROR" }]);
    const events = watch(factoryFor(dht)());

    await vi.waitFor(() => expect(events).toContain("error"));

    expect(dht.attempts).toBe(1);
  });

  it("does not retry errors after the stream opens", async () => {
    const dht = new FakeDHT(["open"]);
    const events = watch(factoryFor(dht)());

    await vi.waitFor(() => expect(events).toContain("open"));
    const error = new Error("late abort") as Error & { code: string };
    error.code = "HOLEPUNCH_ABORTED";
    dht.lastStream!.emit("error", error);

    await vi.waitFor(() => expect(events).toContain("error"));
    expect(dht.attempts).toBe(1);
  });

  it("stops retrying when the caller closes mid-ladder", async () => {
    const dht = new FakeDHT([{ errorCode: "HOLEPUNCH_ABORTED" }]);
    const transport = factoryFor(dht)();
    const events = watch(transport);

    await vi.waitFor(() => expect(dht.attempts).toBe(1));
    transport.close();

    expect(events).toEqual(["close"]);
    // No further dials once closed, even though ladder attempts remained.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(dht.attempts).toBe(1);
  });

  // A phone and daemon on one LAN but different egresses only connect when the
  // dial goes straight to the daemon's LAN address; the daemon says where that
  // is once a connection opens, and every later dial has to use it.
  it("dials the daemon's LAN hint on later connects", async () => {
    const dht = new FakeDHT(["open"]);
    const factory = factoryFor(dht);
    const first = factory();
    const events = watch(first);
    await vi.waitFor(() => expect(events).toContain("open"));
    expect(dht.dialOptions[0]).toEqual({});

    const lan = [{ host: "10.0.10.209", port: 49737 }];
    dht.lastStream!.emit("data", Buffer.from(encodePeerLanHintFrame(lan)));
    first.close();
    factory();

    await vi.waitFor(() => expect(dht.attempts).toBe(2));
    expect(dht.dialOptions[1]).toEqual({ relayAddresses: lan });
  });
});
