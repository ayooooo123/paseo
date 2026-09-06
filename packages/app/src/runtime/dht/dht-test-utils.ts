import { PeerFrameDecoder, PEER_FRAME_CONTROL, encodePeerFrame } from "@getpaseo/protocol/dht-peer";
import type { PeerFrameType } from "@getpaseo/protocol/dht-peer";

/**
 * Shared harness pieces for the HyperDHT worker and native-transport tests.
 * Production code never imports this file — it is a Node test double for the
 * BareKit IPC duplex and a codec for the length-prefixed peer frames both
 * sides speak.
 */

export interface TestFrame {
  type: PeerFrameType;
  payload: Uint8Array;
}

/** Minimal in-memory BareKit IPC duplex: records writes, lets the test inject inbound bytes. */
export class FakeIpc {
  readonly out: Uint8Array[] = [];
  ended = false;
  private readonly listeners = new Map<string, Set<(arg?: unknown) => void>>();

  on(event: string, listener: (arg?: unknown) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  write(chunk: Uint8Array): void {
    this.out.push(chunk);
  }

  end(): void {
    this.ended = true;
  }

  /** Test side: deliver bytes as if the peer wrote them. */
  emitData(chunk: Uint8Array): void {
    for (const listener of this.listeners.get("data") ?? []) listener(chunk);
  }

  emitClose(): void {
    for (const listener of this.listeners.get("close") ?? []) listener();
  }
}

export function encodeControl(message: Record<string, unknown>): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  return encodePeerFrame(PEER_FRAME_CONTROL, payload);
}

export function framesFrom(chunks: Uint8Array[]): TestFrame[] {
  const decoder = new PeerFrameDecoder();
  const frames: TestFrame[] = [];
  for (const chunk of chunks) {
    for (const frame of decoder.push(chunk)) frames.push(frame);
  }
  return frames;
}

export function controlsFrom(chunks: Uint8Array[]): Array<Record<string, unknown>> {
  const controls: Array<Record<string, unknown>> = [];
  for (const frame of framesFrom(chunks)) {
    if (frame.type !== PEER_FRAME_CONTROL) continue;
    controls.push(JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>);
  }
  return controls;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function flushMacrotasks(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
}

export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${description}`);
    await sleep(10);
  }
}
