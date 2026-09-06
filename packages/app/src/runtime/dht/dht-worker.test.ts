import { readFileSync } from "node:fs";
import vm from "node:vm";
import { beforeEach, expect, it } from "vitest";
import {
  DHT_DIAL_MAX_ATTEMPTS,
  DHT_DIAL_RETRY_BASE_MS,
  DHT_DIAL_TRANSIENT_CODES,
  PEER_FRAME_BINARY,
  PEER_FRAME_CONTROL,
  PEER_FRAME_TEXT,
  PeerFrameDecoder,
  decodeBase64Url,
  decodePeerInvite,
  encodeBase64Url,
  encodePeerFrame,
  encodePeerInvite,
} from "@getpaseo/protocol/dht-peer";
import {
  FakeIpc,
  bytesEqual,
  controlsFrom,
  encodeControl,
  flushMacrotasks,
  sleep,
  waitFor,
} from "./dht-test-utils";

/**
 * Deterministic regressions for the dht-worker.mjs dial-lifecycle races:
 *
 * - a superseded connect must not rebuild/clobber the node or dial after it
 *   loses (connect() mutates shared state after awaits);
 * - close/suspend/shutdown must invalidate an in-flight connect and cancel a
 *   scheduled retry, so no dial can resurrect after them;
 * - the retry ladder must dial the same immutable node/target/keyPair;
 * - hyperdht's installed 'network-change' event cancels a live dial with the
 *   existing "closed" frame and keeps the node warm.
 *
 * The worker is a Bare-runtime script whose only dependencies arrive as
 * globals (`BareKit.IPC`, TextEncoder/TextDecoder) and imports (the protocol
 * codec, hyperdht). Node cannot load it as a module, so the harness executes
 * the real source in a fresh `vm` context per test with those boundaries
 * injected: the real protocol module, a controllable fake DHT in place of the
 * hyperdht native addon (a real one would open UDP sockets), and an in-memory
 * IPC duplex. The only textual change is stripping the two static import
 * statements and routing the one dynamic `import("hyperdht")` through a
 * context function; a shape change to the source fails the loader loudly
 * instead of silently drifting.
 */

const KEY_A = new Uint8Array(32).fill(1);
const KEY_B = new Uint8Array(32).fill(2);
const INVITE_A = encodePeerInvite({ publicKey: KEY_A });
const INVITE_B = encodePeerInvite({ publicKey: KEY_B });
const SEED = encodeBase64Url(new Uint8Array(32).fill(9));
const BOOTSTRAP_A = ["127.0.0.1:49737"];
const BOOTSTRAP_B = ["127.0.0.2:49737"];

class FakeStream {
  destroyed = false;
  readonly written: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<(arg?: unknown) => void>>();

  on(event: string, listener: (arg?: unknown) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }

  write(chunk: Uint8Array): void {
    this.written.push(chunk);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

class FakeDHT {
  static instances: FakeDHT[] = [];
  /** When true, resume() parks the caller until releaseResumeGates(). */
  static deferResume = false;
  static resumeGates: Array<() => void> = [];

  static reset(): void {
    FakeDHT.instances = [];
    FakeDHT.deferResume = false;
    FakeDHT.resumeGates = [];
  }

  static keyPair(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
    return { publicKey: seed, secretKey: new Uint8Array(64).fill(3) };
  }

  readonly connectCalls: Array<{
    target: Uint8Array;
    opts: Record<string, unknown>;
    stream: FakeStream;
  }> = [];
  destroyed = false;
  suspendCalls = 0;
  resumeCalls = 0;
  private readonly listeners = new Map<string, Set<(arg?: unknown) => void>>();

  constructor(readonly opts: Record<string, unknown>) {
    FakeDHT.instances.push(this);
  }

  on(event: string, listener: (arg?: unknown) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }

  connect(target: Uint8Array, opts: Record<string, unknown>): FakeStream {
    const stream = new FakeStream();
    this.connectCalls.push({ target, opts, stream });
    return stream;
  }

  async suspend(): Promise<void> {
    this.suspendCalls++;
  }

  async resume(): Promise<void> {
    this.resumeCalls++;
    if (!FakeDHT.deferResume) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    FakeDHT.resumeGates.push(resolve);
    await promise;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

const workerSource = readFileSync(new URL("./dht-worker.mjs", import.meta.url), "utf8");

function workerBody(): string {
  const protocolImport = /import\s*\{[\s\S]*?\}\s*from\s*"@getpaseo\/protocol\/dht-peer";/;
  const polyfillImport = /import\s*"\.\/bare-text-polyfill\.mjs";/;
  const dynamicImport = `(await import("hyperdht")).default`;
  if (!protocolImport.test(workerSource) || !polyfillImport.test(workerSource)) {
    throw new Error("dht-worker.mjs static imports changed; update the VM harness");
  }
  if (!workerSource.includes(dynamicImport)) {
    throw new Error("dht-worker.mjs dynamic hyperdht import changed; update the VM harness");
  }
  const body = workerSource
    .replace(protocolImport, "")
    .replace(polyfillImport, "")
    .replace(dynamicImport, "(await importHyperdht())");
  if (/^\s*import\s/m.test(body))
    throw new Error("dht-worker.mjs has a new static import; update the VM harness");
  return body;
}

function runWorker(ipc: FakeIpc, importHyperdht = async () => FakeDHT): void {
  const sandbox: Record<string, unknown> = {
    BareKit: { IPC: ipc },
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    // The worker stores the module's default export here; connect() awaits
    // importHyperdht() before the first use, so the class exists by dial time.
    importHyperdht,
    PeerFrameDecoder,
    PEER_FRAME_CONTROL,
    PEER_FRAME_TEXT,
    PEER_FRAME_BINARY,
    decodeBase64Url,
    decodePeerInvite,
    encodePeerFrame,
    DHT_DIAL_MAX_ATTEMPTS,
    DHT_DIAL_RETRY_BASE_MS,
    DHT_DIAL_TRANSIENT_CODES,
  };
  vm.runInContext(workerBody(), vm.createContext(sandbox));
}

function sendConnect(ipc: FakeIpc, invite: string, bootstrap?: string[], seed?: string): void {
  const message: Record<string, unknown> = { ipc: "connect", invite };
  if (bootstrap) message.bootstrap = bootstrap;
  if (seed) message.seed = seed;
  ipc.emitData(encodeControl(message));
}

function dhtError(code: string): Error {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

let ipc: FakeIpc;

beforeEach(() => {
  FakeDHT.reset();
  ipc = new FakeIpc();
});

function releaseResumeGates(): void {
  const gates = FakeDHT.resumeGates.splice(0);
  for (const release of gates) release();
}

it("a superseded connect never rebuilds the node or dials after losing", async () => {
  FakeDHT.deferResume = true;
  runWorker(ipc);
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks();
  expect(FakeDHT.instances).toHaveLength(1);

  // The newer connect (different bootstrap) supersedes the first while it is
  // parked inside resume(); the first must not clobber the second's node.
  sendConnect(ipc, INVITE_B, BOOTSTRAP_B);
  await flushMacrotasks();
  expect(FakeDHT.instances).toHaveLength(2);
  expect(FakeDHT.instances[0].destroyed).toBe(true);

  FakeDHT.deferResume = false;
  releaseResumeGates();
  await flushMacrotasks(10);

  const live = FakeDHT.instances[1];
  expect(live.destroyed).toBe(false);
  expect(FakeDHT.instances[0].connectCalls).toHaveLength(0);
  expect(live.connectCalls).toHaveLength(1);
  expect(bytesEqual(live.connectCalls[0].target, KEY_B)).toBe(true);
});

it("suspend closes a connect waiting for resume instead of stranding RN in connecting", async () => {
  FakeDHT.deferResume = true;
  runWorker(ipc);
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks();
  ipc.emitData(encodeControl({ ipc: "suspend" }));
  expect(controlsFrom(ipc.out).map((value) => value.ipc)).toContain("closed");
  FakeDHT.deferResume = false;
  releaseResumeGates();
  await flushMacrotasks();
  expect(FakeDHT.instances[0].connectCalls).toHaveLength(0);
  expect(controlsFrom(ipc.out).map((value) => value.ipc)).toContain("suspended");
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks();
  expect(FakeDHT.instances[0].connectCalls).toHaveLength(1);
  ipc.emitData(encodeControl({ ipc: "shutdown" }));
});

it("a cancelled native import failure cannot fail the replacement transport", async () => {
  const importing = Promise.withResolvers<typeof FakeDHT>();
  runWorker(ipc, () => importing.promise);
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  ipc.emitData(encodeControl({ ipc: "close" }));
  importing.reject(new Error("Native module failed after cancellation"));
  await flushMacrotasks();
  expect(controlsFrom(ipc.out)).toEqual([]);
  expect(FakeDHT.instances).toHaveLength(0);
});

it("close supersedes an in-flight connect but keeps the node warm for the next dial", async () => {
  FakeDHT.deferResume = true;
  runWorker(ipc);
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks();
  expect(FakeDHT.instances).toHaveLength(1);

  ipc.emitData(encodeControl({ ipc: "close" }));
  FakeDHT.deferResume = false;
  releaseResumeGates();
  await flushMacrotasks(10);

  const node = FakeDHT.instances[0];
  expect(node.connectCalls).toHaveLength(0);
  expect(node.destroyed).toBe(false);

  sendConnect(ipc, INVITE_B, BOOTSTRAP_A);
  await flushMacrotasks(10);
  expect(FakeDHT.instances).toHaveLength(1);
  expect(node.connectCalls).toHaveLength(1);
  expect(bytesEqual(node.connectCalls[0].target, KEY_B)).toBe(true);
});

it("close cancels a scheduled retry so no dial resurrects", async () => {
  runWorker(ipc);
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks();
  const node = FakeDHT.instances[0];
  expect(node.connectCalls).toHaveLength(1);

  node.connectCalls[0].stream.emit("error", dhtError("HOLEPUNCH_ABORTED"));
  ipc.emitData(encodeControl({ ipc: "close" }));
  await sleep(650); // past the 400ms backoff of the cancelled retry

  expect(node.connectCalls).toHaveLength(1);
  expect(node.destroyed).toBe(false);
  const surfaced = controlsFrom(ipc.out).filter(
    (control) => control.ipc === "closed" || control.ipc === "error",
  );
  expect(surfaced).toHaveLength(0);

  sendConnect(ipc, INVITE_B, BOOTSTRAP_A);
  await flushMacrotasks(10);
  expect(node.connectCalls).toHaveLength(2);
});

it("shutdown cancels a scheduled retry and destroys the node", async () => {
  runWorker(ipc);
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks();
  const node = FakeDHT.instances[0];

  node.connectCalls[0].stream.emit("error", dhtError("HOLEPUNCH_ABORTED"));
  ipc.emitData(encodeControl({ ipc: "shutdown" }));
  await flushMacrotasks();
  expect(node.destroyed).toBe(true);
  await sleep(650);

  expect(node.connectCalls).toHaveLength(1);
});

it("shutdown supersedes a connect still awaiting resume — no dial survives teardown", async () => {
  FakeDHT.deferResume = true;
  runWorker(ipc);
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks();
  expect(FakeDHT.instances).toHaveLength(1);

  ipc.emitData(encodeControl({ ipc: "shutdown" }));
  FakeDHT.deferResume = false;
  releaseResumeGates();
  await flushMacrotasks(10);

  expect(FakeDHT.instances[0].destroyed).toBe(true);
  expect(FakeDHT.instances[0].connectCalls).toHaveLength(0);
});

it("suspend during retry backoff reports closed, parks the node, and never dials until a fresh connect", async () => {
  runWorker(ipc);
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks();
  const node = FakeDHT.instances[0];

  node.connectCalls[0].stream.emit("error", dhtError("HOLEPUNCH_ABORTED"));
  ipc.emitData(encodeControl({ ipc: "suspend" }));
  await flushMacrotasks();

  expect(node.suspendCalls).toBe(1);
  const sequence = controlsFrom(ipc.out)
    .filter((control) => control.ipc === "closed" || control.ipc === "suspended")
    .map((control) => control.ipc);
  expect(sequence).toEqual(["closed", "suspended"]);
  await sleep(650);
  expect(node.connectCalls).toHaveLength(1);

  ipc.emitData(encodeControl({ ipc: "resume" }));
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks(10);
  expect(node.connectCalls).toHaveLength(2);
  expect(node.destroyed).toBe(false);
});

it("retries reuse the same immutable node, target, and keypair", async () => {
  runWorker(ipc);
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A, SEED);
  await flushMacrotasks();
  const node = FakeDHT.instances[0];
  expect(node.connectCalls).toHaveLength(1);
  const first = node.connectCalls[0];
  expect(first.opts.keyPair).toBeDefined();

  first.stream.emit("error", dhtError("HOLEPUNCH_ABORTED"));
  await waitFor(() => node.connectCalls.length === 2, "second dial attempt");

  const second = node.connectCalls[1];
  expect(second.stream).not.toBe(first.stream);
  expect(bytesEqual(second.target, first.target)).toBe(true);
  expect(second.opts.keyPair).toBe(first.opts.keyPair);
  expect(second.opts.reusableSocket).toBe(true);
  const surfaced = controlsFrom(ipc.out).filter(
    (control) => control.ipc === "error" || control.ipc === "closed",
  );
  expect(surfaced).toHaveLength(0);

  second.stream.emit("open");
  const opens = controlsFrom(ipc.out).filter((control) => control.ipc === "open");
  expect(opens).toHaveLength(1);
});

it("network-change cancels an open dial with 'closed' and keeps the node warm", async () => {
  runWorker(ipc);
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks();
  const node = FakeDHT.instances[0];
  node.connectCalls[0].stream.emit("open");
  expect(controlsFrom(ipc.out).filter((control) => control.ipc === "open")).toHaveLength(1);

  node.emit("network-change");
  await flushMacrotasks();

  expect(controlsFrom(ipc.out).filter((control) => control.ipc === "closed")).toHaveLength(1);
  expect(node.connectCalls).toHaveLength(1);
  expect(node.destroyed).toBe(false);

  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks(10);
  expect(FakeDHT.instances).toHaveLength(1);
  expect(node.connectCalls).toHaveLength(2);
});

it("network-change cancels a connect parked in resume and keeps the node warm", async () => {
  FakeDHT.deferResume = true;
  runWorker(ipc);
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks();
  const node = FakeDHT.instances[0];
  node.emit("network-change");
  FakeDHT.deferResume = false;
  releaseResumeGates();
  await flushMacrotasks();
  expect(node.connectCalls).toHaveLength(0);
  expect(controlsFrom(ipc.out).filter((control) => control.ipc === "closed")).toHaveLength(1);
  expect(node.destroyed).toBe(false);
  sendConnect(ipc, INVITE_A, BOOTSTRAP_A);
  await flushMacrotasks();
  expect(FakeDHT.instances).toHaveLength(1);
  expect(node.connectCalls).toHaveLength(1);
  ipc.emitData(encodeControl({ ipc: "shutdown" }));
});
