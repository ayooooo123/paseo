import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DaemonClient } from "./daemon-client";
import type { DaemonTransport } from "./daemon-client-transport-types";

class Peer {
  private opened = new Set<() => void>();
  private received = new Set<(data: unknown, isBinary: boolean) => void>();
  private closed = new Set<(event?: unknown) => void>();
  private errors = new Set<(event: unknown) => void>();
  closes = 0;
  sends = 0;
  transport: DaemonTransport = {
    send: () => {
      this.sends++;
    },
    close: () => {
      this.closes += 1;
    },
    onOpen: (handler) => {
      this.opened.add(handler);
      return () => this.opened.delete(handler);
    },
    onMessage: (handler) => {
      this.received.add(handler);
      return () => this.received.delete(handler);
    },
    onClose: (handler) => {
      this.closed.add(handler);
      return () => this.closed.delete(handler);
    },
    onError: (handler) => {
      this.errors.add(handler);
      return () => this.errors.delete(handler);
    },
  };
  open(): void {
    for (const handler of this.opened) handler();
  }
  ready(): void {
    const message = JSON.stringify({
      type: "session",
      message: {
        type: "status",
        payload: {
          status: "server_info",
          serverId: "deadline-host",
          hostname: null,
          version: null,
        },
      },
    });
    for (const handler of this.received) handler(message, false);
  }
  failAndClose(): void {
    for (const handler of this.errors) handler(new Error("Transport error"));
    for (const handler of this.closed) handler();
  }
}

const clients: DaemonClient[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function connect(peer: Peer, options: { connectTimeoutMs?: number; helloTimeoutMs?: number } = {}) {
  const client = new DaemonClient({
    url: "ws://deadline.invalid/ws",
    clientId: "deadline-device",
    connectTimeoutMs: 1000,
    helloTimeoutMs: 100,
    ...options,
    reconnect: { enabled: false },
    transportFactory: () => peer.transport,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  clients.push(client);
  const pending = client.connect().then(
    () => null,
    (error: unknown) => error,
  );
  return { client, pending };
}

test("a slow dial does not consume the hello-only timeout", async () => {
  const peer = new Peer();
  const { client, pending } = connect(peer);
  await vi.advanceTimersByTimeAsync(500);
  expect(client.getConnectionState().status).toBe("connecting");
  peer.open();
  await vi.advanceTimersByTimeAsync(90);
  peer.ready();
  expect(await pending).toBeNull();
  await vi.advanceTimersByTimeAsync(1000);
  expect(client.isConnected).toBe(true);
  expect(peer.closes).toBe(0);
});

test("a silent open peer fails at the hello deadline, not the dial budget", async () => {
  const peer = new Peer();
  const { client, pending } = connect(peer);
  peer.open();
  await vi.advanceTimersByTimeAsync(100);
  expect(await pending).toEqual(new Error("Daemon hello timed out"));
  expect(client.getConnectionState().status).toBe("disconnected");
  expect(peer.closes).toBe(1);
});

test("opening near the total deadline does not extend the connection budget", async () => {
  const peer = new Peer();
  const { client, pending } = connect(peer);
  await vi.advanceTimersByTimeAsync(950);
  peer.open();
  await vi.advanceTimersByTimeAsync(50);
  expect(await pending).toEqual(new Error("Daemon hello timed out"));
  expect(client.getConnectionState().status).toBe("disconnected");
});

test("duplicate open notifications cannot keep an unresponsive peer alive", async () => {
  const peer = new Peer();
  const { pending } = connect(peer);
  peer.open();
  await vi.advanceTimersByTimeAsync(80);
  peer.open();
  await vi.advanceTimersByTimeAsync(20);
  expect(await pending).toEqual(new Error("Daemon hello timed out"));
  expect(peer.closes).toBe(1);
});

test.each(["dial", "hello"])("closing during %s rejects the pending connection", async (stage) => {
  const peer = new Peer();
  const { client, pending } = connect(peer);
  if (stage === "hello") peer.open();
  await client.close();
  expect(await pending).toEqual(new Error("Daemon client closed"));
});

test("an event-less close preserves the preceding transport failure", async () => {
  const peer = new Peer();
  const { client, pending } = connect(peer);
  peer.open();
  peer.ready();
  await pending;
  peer.failAndClose();
  expect(client.lastError).toBe("Transport error");
  expect(client.getConnectionState()).toMatchObject({
    status: "disconnected",
    reason: "Transport error",
  });
});

test("an omitted hello cap preserves a custom total connection budget", async () => {
  const peer = new Peer();
  const { client, pending } = connect(peer, {
    connectTimeoutMs: 60_000,
    helloTimeoutMs: undefined,
  });
  await vi.advanceTimersByTimeAsync(20_000);
  peer.open();
  await vi.advanceTimersByTimeAsync(16_000);
  peer.ready();
  expect(await pending).toBeNull();
  expect(client.isConnected).toBe(true);
});

test("an open after the total deadline cannot send hello when timers are delayed", async () => {
  const peer = new Peer();
  const { client, pending } = connect(peer);
  vi.spyOn(performance, "now").mockReturnValue(performance.now() + 1001);
  peer.open();
  peer.ready();
  expect(peer.sends).toBe(0);
  expect(await pending).toEqual(new Error("Connection timed out"));
  expect(client.isConnected).toBe(false);
});
