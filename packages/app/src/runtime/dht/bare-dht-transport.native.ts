import { AppState, type AppStateStatus } from "react-native";
import { Worklet } from "react-native-bare-kit";
import {
  PeerFrameDecoder,
  PEER_FRAME_CONTROL,
  PEER_FRAME_TEXT,
  PEER_FRAME_BINARY,
  encodePeerFrame,
  encodePeerBinaryFrame,
  encodePeerTextFrame,
} from "@getpaseo/protocol/dht-peer";
import type {
  DaemonTransport,
  DaemonTransportFactory,
} from "@getpaseo/client/internal/daemon-client-transport-types";
import { getDhtClientSeed } from "./dht-client-identity";

/**
 * React Native HyperDHT transport. Spawns a Bare worklet (`dht-worker.mjs`,
 * packed by `bare-pack`) that owns the DHT node + capability handshake, and
 * bridges Paseo application bytes across the BareKit IPC duplex. The RN side
 * never touches `hyperdht`/crypto — it only frames app bytes with the RN-safe
 * `dht-peer` codec.
 *
 * The worklet outlives a single connection. Dialing costs a DHT bootstrap plus
 * a cold lookup and holepunch (~1.7s measured against a LAN daemon over the
 * public DHT), and the client reconnects whenever the phone sleeps or the
 * heartbeat lapses. Keeping the node warm between dials preserves the routing
 * table and peer-address cache; the worklet is torn down only after the
 * connection has stayed gone past the client's maximum reconnect backoff.
 */
export interface BareDhtTransportOptions {
  invite: string;
  bootstrap?: string[];
  /** bare-pack output for `dht-worker.mjs`; supplied by the build. */
  workerBundle: string;
}

type MessageHandler = (data: unknown, isBinary: boolean) => void;
type VoidHandler = () => void;
type EventHandler = (event?: unknown) => void;

const te = new TextEncoder();
const td = new TextDecoder();

/** How long a released worklet stays warm. A parked node resumes without
 * re-bootstrapping, so keeping it costs little and saves the whole cold path.
 * Bounded by reality, not by this number: when the OS kills the process
 * instead of freezing it, nothing here survives. */
const IDLE_SHUTDOWN_MS = 5 * 60_000;

/** How long to let the worker park the DHT before freezing its thread. Missing
 * the ack is not fatal — the node comes back parked either way — so this only
 * has to be short enough not to hold up backgrounding. */
const SUSPEND_ACK_TIMEOUT_MS = 400;

interface IpcDuplex {
  write(data: Uint8Array): void;
  end(): void;
  on(event: "data", listener: (chunk: Uint8Array) => void): void;
  on(event: "close" | "error", listener: (arg?: unknown) => void): void;
}

/** Sink for whichever transport currently owns the worklet's single stream. */
interface SessionSink {
  onControl(message: { ipc?: string; message?: string; code?: string }): void;
  onApp(type: number, payload: Uint8Array): void;
  onError(error: unknown): void;
  onClose(): void;
}

interface WorkletSession {
  connect(sink: SessionSink): void;
  send(frame: Uint8Array): void;
  release(sink: SessionSink): void;
}

const sessions = new Map<string, WorkletSession>();

function sessionKey(options: BareDhtTransportOptions): string {
  return `${options.invite}\u0000${(options.bootstrap ?? []).join(",")}`;
}

function createWorkletSession(options: BareDhtTransportOptions, key: string): WorkletSession {
  const worklet = new Worklet();
  worklet.start("/dht-worker.bundle", options.workerBundle);
  const ipc = worklet.IPC as unknown as IpcDuplex;
  const decoder = new PeerFrameDecoder();

  let sink: SessionSink | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const control = (message: Record<string, unknown>): void => {
    ipc.write(encodePeerFrame(PEER_FRAME_CONTROL, te.encode(JSON.stringify(message))));
  };

  // Two layers park here, and the order matters. `dht.suspend()` runs inside the
  // worklet, so freezing the worklet first would strand the control frame that
  // asks for it. Park the node, wait for the ack, then freeze the thread.
  //
  // Only `active` and `background` are acted on. `inactive` fires on iOS for the
  // app switcher, Control Center and permission dialogs while the app is still
  // on screen; treating it as backgrounded parked a live connection. This is the
  // same filter BareKit's own `Worklet#update` applies
  // (react-native-bare-kit/index.js:293-300).
  let suspendAck: ((value: void) => void) | null = null;
  // Bumped by every lifecycle event. A park that was in flight when the app came
  // back finds a stale generation and abandons the freeze, instead of putting a
  // foregrounded app's worklet to sleep a few hundred ms after it woke.
  let lifecycleGeneration = 0;

  const parkWorklet = async (): Promise<void> => {
    const generation = lifecycleGeneration;
    control({ ipc: "suspend" });
    await new Promise<void>((resolve) => {
      suspendAck = resolve;
      setTimeout(resolve, SUSPEND_ACK_TIMEOUT_MS);
    });
    suspendAck = null;
    if (disposed || generation !== lifecycleGeneration) return;
    try {
      worklet.suspend();
    } catch {
      // Already suspended or terminated; nothing to park.
    }
  };

  const appStateSub = AppState.addEventListener("change", (state: AppStateStatus) => {
    if (disposed) return;
    if (state !== "active" && state !== "background") return;
    lifecycleGeneration++;
    if (state === "background") {
      void parkWorklet();
      return;
    }
    try {
      worklet.resume();
    } catch {
      // Not suspended; the control frame below is still correct.
    }
    control({ ipc: "resume" });
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearTimeout(idleTimer ?? undefined);
    if (sessions.get(key) === session) sessions.delete(key);
    appStateSub.remove();
    try {
      control({ ipc: "shutdown" });
      ipc.end();
    } catch {
      // ignore
    }
    try {
      worklet.terminate();
    } catch {
      // ignore
    }
  };

  ipc.on("data", (chunk) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch {
      return;
    }
    for (const { type, payload } of frames) {
      if (type === PEER_FRAME_CONTROL) {
        const message = JSON.parse(td.decode(payload)) as {
          ipc?: string;
          message?: string;
          code?: string;
          [key: string]: unknown;
        };
        // Lifecycle acks belong to the session, not to whichever transport
        // currently holds the stream, and they arrive when there is no sink.
        if (message.ipc === "suspended") {
          suspendAck?.();
          continue;
        }
        if (message.ipc === "resumed") continue;
        sink?.onControl(message);
        continue;
      }
      sink?.onApp(type, payload);
    }
  });
  ipc.on("close", () => {
    sink?.onClose();
    dispose();
  });
  ipc.on("error", (error) => sink?.onError(error));

  // Read once per session, not per dial. Keychain access is async and the
  // transport factory is not, so the connect frame waits on the seed rather than
  // the caller waiting on the transport.
  const seedPromise = getDhtClientSeed();

  const session: WorkletSession = {
    connect(next) {
      clearTimeout(idleTimer ?? undefined);
      idleTimer = null;
      sink = next;
      void (async () => {
        const seed = await seedPromise;
        // A release or a newer connect landed while the Keychain read was in
        // flight; that dial is no longer wanted.
        if (disposed || sink !== next) return;
        control({
          ipc: "connect",
          invite: options.invite,
          bootstrap: options.bootstrap,
          ...(seed ? { seed } : {}),
        });
      })();
    },
    send(frame) {
      ipc.write(frame);
    },
    release(previous) {
      if (sink !== previous) return;
      sink = null;
      try {
        control({ ipc: "close" });
      } catch {
        // ignore
      }
      clearTimeout(idleTimer ?? undefined);
      idleTimer = setTimeout(dispose, IDLE_SHUTDOWN_MS);
    },
  };
  return session;
}

export function createBareDhtTransportFactory(
  options: BareDhtTransportOptions,
): DaemonTransportFactory {
  const key = sessionKey(options);

  return (): DaemonTransport => {
    let session = sessions.get(key);
    if (!session) {
      session = createWorkletSession(options, key);
      sessions.set(key, session);
    }
    const active = session;

    const openHandlers = new Set<VoidHandler>();
    const messageHandlers = new Set<MessageHandler>();
    const closeHandlers = new Set<EventHandler>();
    const errorHandlers = new Set<EventHandler>();
    const pending: Array<[unknown, boolean]> = [];
    let open = false;
    let closed = false;

    const deliver = (data: unknown, isBinary: boolean): void => {
      if (messageHandlers.size === 0) {
        pending.push([data, isBinary]);
        return;
      }
      for (const handler of messageHandlers) handler(data, isBinary);
    };
    const fireClose = (event?: unknown): void => {
      if (closed) return;
      closed = true;
      open = false;
      for (const handler of closeHandlers) handler(event);
      active.release(sink);
    };

    const sink: SessionSink = {
      onControl(message) {
        if (message.ipc === "open") {
          open = true;
          for (const handler of openHandlers) handler();
        } else if (message.ipc === "closed") {
          fireClose();
        } else if (message.ipc === "error") {
          const err = new Error(message.message ?? "dht error") as Error & { code?: string };
          if (message.code) err.code = message.code;
          console.log(
            `[dht-error] code=${message.code ?? "none"} message=${message.message ?? ""}`,
          );
          for (const handler of errorHandlers) handler(err);
        }
      },
      onApp(type, payload) {
        if (type === PEER_FRAME_TEXT) deliver(td.decode(payload), false);
        // slice() already produces an exact-length buffer; copying it again
        // doubled the cost of every binary message.
        else if (type === PEER_FRAME_BINARY) deliver(payload.slice().buffer, true);
      },
      onError(error) {
        for (const handler of errorHandlers) handler(error);
      },
      onClose() {
        fireClose();
      },
    };

    active.connect(sink);

    return {
      send: (data) => {
        if (!open) throw new Error("bare dht transport not open");
        active.send(
          typeof data === "string"
            ? encodePeerTextFrame(data)
            : encodePeerBinaryFrame(data instanceof ArrayBuffer ? new Uint8Array(data) : data),
        );
      },
      close: () => {
        if (closed) return;
        closed = true;
        open = false;
        active.release(sink);
      },
      onMessage: (handler) => {
        messageHandlers.add(handler);
        if (pending.length > 0) {
          const drained = pending.splice(0, pending.length);
          for (const [data, isBinary] of drained) handler(data, isBinary);
        }
        return () => messageHandlers.delete(handler);
      },
      onOpen: (handler) => {
        openHandlers.add(handler);
        if (open) handler();
        return () => openHandlers.delete(handler);
      },
      onClose: (handler) => {
        closeHandlers.add(handler);
        return () => closeHandlers.delete(handler);
      },
      onError: (handler) => {
        errorHandlers.add(handler);
        return () => errorHandlers.delete(handler);
      },
    };
  };
}
