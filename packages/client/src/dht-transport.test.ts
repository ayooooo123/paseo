import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type DHT from "hyperdht";
import type { HyperDhtKeyPair } from "hyperdht";
import {
  DHT_DIAL_MAX_ATTEMPTS,
  encodePeerInvite,
  encodePeerBinaryFrame,
  encodePeerTextFrame,
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
  destroyCalls = 0;
  lastStream: FakeStream | null = null;
  lastConnectKeyPair: HyperDhtKeyPair | null = null;

  constructor(private readonly outcomes: readonly DialOutcome[]) {}

  connect(_publicKey?: unknown, options?: { keyPair?: HyperDhtKeyPair }): FakeStream {
    const outcome = this.outcomes[Math.min(this.attempts, this.outcomes.length - 1)]!;
    this.attempts += 1;
    this.lastConnectKeyPair = options?.keyPair ?? null;
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
    this.destroyCalls += 1;
  }
}

const INVITE = encodePeerInvite({ publicKey: new Uint8Array(32).fill(7) });

function factoryFor(dht: FakeDHT, options?: { keyPair?: HyperDhtKeyPair }) {
  return createDhtTransportFactory({
    invite: INVITE,
    createDht: () => dht as unknown as DHT,
    ...options,
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
    const factory = factoryFor(dht);
    const events = watch(factory());

    await vi.waitFor(() => expect(events).toContain("error"), { timeout: 10_000 });

    expect(dht.attempts).toBe(DHT_DIAL_MAX_ATTEMPTS);
    expect(events.filter((e) => e === "error")).toHaveLength(1);
    // The failed socket's close follows the error, as hyperdht destroys it.
    await vi.waitFor(() => expect(events).toContain("close"));
    // The stream is gone but the node belongs to the factory: only dispose
    // releases it, so a reconnect (or another session) can reuse the node.
    expect(dht.destroyed).toBe(false);
    await factory.dispose?.();
    expect(dht.destroyed).toBe(true);
    expect(dht.destroyCalls).toBe(1);
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

  it("reuses one node and key across reconnect streams, releasing both on dispose", async () => {
    const keyPair: HyperDhtKeyPair = {
      publicKey: Buffer.alloc(32, 3),
      secretKey: Buffer.alloc(64, 4),
    };
    const dht = new FakeDHT(["open", "open"]);
    const factory = factoryFor(dht, { keyPair });

    const first = factory();
    const firstEvents = watch(first);
    await vi.waitFor(() => expect(firstEvents).toContain("open"));

    // A stream close must not destroy the node another stream will reuse.
    first.close();
    await vi.waitFor(() => expect(firstEvents).toContain("close"));
    expect(dht.destroyed).toBe(false);

    const second = factory();
    const secondEvents = watch(second);
    await vi.waitFor(() => expect(secondEvents).toContain("open"));
    expect(dht.attempts).toBe(2);
    expect(dht.lastConnectKeyPair?.publicKey.equals(keyPair.publicKey)).toBe(true);
    expect(dht.lastConnectKeyPair?.secretKey.equals(keyPair.secretKey)).toBe(true);

    await factory.dispose?.();
    expect(dht.destroyed).toBe(true);
    expect(dht.destroyCalls).toBe(1);
  });

  it("does not let an older stream's late close kill a newer stream or the node", async () => {
    const dht = new FakeDHT(["open", "open"]);
    const factory = factoryFor(dht);

    const older = factory();
    const olderEvents = watch(older);
    await vi.waitFor(() => expect(olderEvents).toContain("open"));

    const newer = factory();
    const newerEvents = watch(newer);
    await vi.waitFor(() => expect(newerEvents).toContain("open"));

    // Teardown of the previous generation lands after the new dial opened.
    older.close();
    await vi.waitFor(() => expect(olderEvents).toContain("close"));
    expect(newerEvents).toEqual(["open"]);
    expect(() => newer.send("payload")).not.toThrow();
    expect(dht.attempts).toBe(2);
    expect(dht.destroyed).toBe(false);

    await factory.dispose?.();
    expect(dht.destroyed).toBe(true);
    expect(dht.destroyCalls).toBe(1);
  });

  it("disposes the node once when dispose is called twice", async () => {
    const dht = new FakeDHT(["open"]);
    const factory = factoryFor(dht);
    const events = watch(factory());

    await vi.waitFor(() => expect(events).toContain("open"));
    await factory.dispose?.();
    await factory.dispose?.();
    expect(dht.destroyCalls).toBe(1);
  });

  it("waits for node destruction when a close handler reenters dispose", async () => {
    const dht = new FakeDHT(["open"]);
    const release = Promise.withResolvers<void>();
    dht.destroy = async () => {
      dht.destroyCalls++;
      await release.promise;
      dht.destroyed = true;
    };
    const factory = factoryFor(dht);
    const transport = factory();
    const events = watch(transport);
    await vi.waitFor(() => expect(events).toContain("open"));
    transport.onClose(() => {
      void factory.dispose();
    });
    let settled = false;
    const disposing = factory.dispose().then(() => {
      settled = true;
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(() => factory()).toThrow("disposed");
    release.resolve();
    await disposing;
    expect(dht.destroyed).toBe(true);
    expect(dht.destroyCalls).toBe(1);
  });

  it("delivers only each binary payload from a pooled multi-frame buffer", async () => {
    const dht = new FakeDHT(["open"]);
    const factory = factoryFor(dht);
    const transport = factory();
    const received: ArrayBuffer[] = [];
    transport.onMessage((data, binary) => {
      if (binary) received.push(data as ArrayBuffer);
    });
    const events = watch(transport);
    await vi.waitFor(() => expect(events).toContain("open"));
    const chunk = Buffer.concat([
      encodePeerTextFrame("separator"),
      encodePeerBinaryFrame(new Uint8Array([11, 22])),
      encodePeerBinaryFrame(new Uint8Array([33])),
    ]);
    dht.lastStream!.emit("data", chunk);
    chunk.fill(0);
    expect(received.map((data) => data.byteLength)).toEqual([2, 1]);
    expect(received).toEqual([new Uint8Array([11, 22]).buffer, new Uint8Array([33]).buffer]);
    await factory.dispose();
  });

  it("releases every stream and the node when a native stream destroy throws", async () => {
    const dht = new FakeDHT(["open"]);
    const factory = factoryFor(dht);
    const first = factory();
    const failedStream = dht.lastStream!;
    const second = factory();
    const closed: string[] = [];
    first.onClose(() => closed.push("first"));
    second.onClose(() => closed.push("second"));
    failedStream.destroy = () => {
      throw new Error("Native destroy failed");
    };
    const failure = await factory.dispose().catch((error) => error);
    expect(closed).toEqual(["first", "second"]);
    expect(dht.destroyed).toBe(true);
    expect(failure).toBeInstanceOf(AggregateError);
  });
});
