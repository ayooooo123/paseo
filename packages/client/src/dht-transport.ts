/**
 * HyperDHT client transport for the Node/desktop daemon client.
 *
 * Produces a `DaemonTransportFactory` that dials a daemon by its
 * `paseo-peer://v1/...` invite and presents the Noise stream as a
 * `DaemonTransport`. HyperDHT authenticates the dial itself, so the transport is
 * open as soon as the stream is. This module imports `hyperdht`, so it is
 * Node-only and must never be pulled into the React Native bundle (the mobile
 * app uses a Bare worker instead).
 *
 * The factory owns one DHT node per scope (invite target + identity + bootstrap
 * configuration). Every stream it dials shares that node, so a reconnect keeps
 * the routing table and keypair instead of starting from a cold node. A stream
 * close never destroys the node; `factory.dispose()` releases it when the
 * owning `DaemonClient` closes permanently.
 */
import DHT, { type HyperDhtKeyPair, type HyperDhtStream } from "hyperdht";
import {
  PeerFrameDecoder,
  PEER_FRAME_TEXT,
  PEER_FRAME_BINARY,
  decodePeerInvite,
  encodePeerBinaryFrame,
  encodePeerTextFrame,
  DHT_DIAL_MAX_ATTEMPTS,
  DHT_DIAL_RETRY_BASE_MS,
  DHT_DIAL_TRANSIENT_CODES,
} from "@getpaseo/protocol/dht-peer";
import { copyArrayBufferViewToBuffer } from "./daemon-client-transport-utils.js";
import type { DaemonTransport, DaemonTransportFactory } from "./daemon-client-transport-types.js";

export interface DhtTransportOptions {
  invite: string;
  /** Optional bootstrap override (e.g. a testnet); defaults to the public DHT. */
  bootstrap?: readonly string[];
  /** Deterministic node identity: a 32-byte seed deriving the node keypair. */
  seed?: Buffer | Uint8Array;
  /** Exact node keypair; wins over `seed` when both are given. */
  keyPair?: HyperDhtKeyPair;
  createDht?: () => DHT;
}

type MessageHandler = (data: unknown, isBinary: boolean) => void;
type VoidHandler = () => void;
type EventHandler = (event?: unknown) => void;

export function createDhtTransportFactory(options: DhtTransportOptions) {
  const { publicKey } = decodePeerInvite(options.invite);

  // The Noise identity for every dial: the externally supplied keyPair, the
  // keyPair derived from the seed, or the node's own default when neither is
  // given. Passing it per connect() keeps the client keypair stable even when
  // a custom node factory is injected (tests), which would otherwise drop the
  // identity options.
  const dialKeyPair = options.keyPair ?? (options.seed ? DHT.keyPair(options.seed) : undefined);
  const dialOptions = {
    ...(dialKeyPair ? { keyPair: dialKeyPair } : {}),
    // Reuse the punched UDP route to this daemon from the node's socket pool:
    // a reconnect retries the established route first and falls back to a
    // fresh holepunch only if it is gone (lib/connect.js retryRoute).
    reusableSocket: true,
  };

  let node: DHT | null = null;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  const closeStreams = new Set<() => void>();

  const ensureNode = (): DHT => {
    if (disposed) {
      throw new Error("dht transport factory is disposed");
    }
    if (!node) {
      node =
        options.createDht?.() ??
        new DHT({
          ...(options.bootstrap ? { bootstrap: [...options.bootstrap] } : {}),
          ...(dialKeyPair ? { keyPair: dialKeyPair } : {}),
        });
    }
    return node;
  };

  const releaseNode = (): Promise<void> => {
    if (!disposePromise) {
      disposed = true;
      const dht = node;
      node = null;
      // Publish the release promise before close handlers can reenter dispose.
      disposePromise = (async () => {
        await Promise.resolve();
        let errors: unknown[] | undefined;
        for (const close of closeStreams) {
          try {
            close();
          } catch (error) {
            (errors ??= []).push(error);
          }
        }
        try {
          await dht?.destroy();
        } catch (error) {
          (errors ??= []).push(error);
        }
        if (errors) throw new AggregateError(errors, "Failed to release DHT transport resources");
      })();
    }
    return disposePromise;
  };

  const factory = (_connection?: Parameters<DaemonTransportFactory>[0]): DaemonTransport => {
    const dht = ensureNode();

    // One hyperdht connect() is exactly one attempt: a transient failure
    // destroys the socket and upstream retries nothing (lib/connect.js). The
    // ladder below absorbs single probe-window failures (a dozing phone eats
    // one ~10s probe round, then punches cleanly on the next dial). Pre-open
    // only: once open, an error is a dropped connection, not a dial failure.
    let current: { stream: HyperDhtStream; dead: boolean } | null = null;
    let dialAttempt = 0;
    let retryTimer: NodeJS.Timeout | null = null;
    const openHandlers = new Set<VoidHandler>();
    const messageHandlers = new Set<MessageHandler>();
    const closeHandlers = new Set<EventHandler>();
    const errorHandlers = new Set<EventHandler>();
    const pending: Array<[unknown, boolean]> = [];

    // "connecting" until HyperDHT reports the Noise stream open: onOpen replays
    // for late subscribers off this value, so claiming open early would let the
    // client send its hello into a stream that has not handshaked yet.
    let phase: "connecting" | "open" | "closed" = "connecting";
    const scheduleRetry = (): void => {
      const timer = setTimeout(() => {
        retryTimer = null;
        if (!disposed && phase === "connecting") {
          startDial();
        }
      }, DHT_DIAL_RETRY_BASE_MS * dialAttempt);
      retryTimer = timer;
    };
    const clearRetry = (): void => {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
    const startDial = (): void => {
      dialAttempt += 1;
      const attempt = {
        stream: dht.connect(publicKey, dialOptions),
        dead: false,
      };
      current = attempt;
      const live = (): boolean => !attempt.dead && current === attempt;
      const decoder = new PeerFrameDecoder();

      attempt.stream.on("open", () => {
        if (!live() || phase !== "connecting") return;
        phase = "open";
        for (const handler of openHandlers) handler();
      });
      attempt.stream.on("data", (chunk) => {
        if (!live()) return;
        let frames;
        try {
          frames = decoder.push(chunk);
        } catch {
          attempt.stream.destroy();
          return;
        }
        for (const { type, payload } of frames) {
          if (type === PEER_FRAME_TEXT) {
            deliver(new TextDecoder("utf-8", { fatal: false }).decode(payload), false);
          } else if (type === PEER_FRAME_BINARY) {
            deliver(copyArrayBufferViewToBuffer(payload), true);
          }
        }
      });
      attempt.stream.on("end", () => {
        if (live()) fireClose();
      });
      attempt.stream.on("close", () => {
        if (live()) fireClose();
      });
      attempt.stream.on("error", (error) => {
        if (!live()) return;
        const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
        if (
          phase === "connecting" &&
          dialAttempt < DHT_DIAL_MAX_ATTEMPTS &&
          code !== undefined &&
          DHT_DIAL_TRANSIENT_CODES[code] === true
        ) {
          // Abandon and retry: mark the attempt dead first, so the destroyed
          // socket's close event can't fire a spurious onClose for a dial that
          // is about to be retried.
          attempt.dead = true;
          current = null;
          try {
            attempt.stream.destroy();
          } catch {
            // ignore
          }
          scheduleRetry();
          return;
        }
        for (const handler of errorHandlers) handler(error);
      });
    };

    const fireClose = (event?: unknown): void => {
      if (phase === "closed") return;
      phase = "closed";
      clearRetry();
      closeStreams.delete(fireClose);
      pending.length = 0;
      const attempt = current;
      current = null;
      try {
        if (attempt) {
          attempt.dead = true;
          attempt.stream.destroy();
        }
      } finally {
        for (const handler of closeHandlers) handler(event);
      }
    };
    const deliver = (data: unknown, isBinary: boolean): void => {
      if (messageHandlers.size === 0) {
        pending.push([data, isBinary]);
        return;
      }
      for (const handler of messageHandlers) handler(data, isBinary);
    };

    closeStreams.add(fireClose);
    try {
      startDial();
    } catch (error) {
      fireClose();
      throw error;
    }
    return {
      send: (data) => {
        if (phase !== "open" || !current) throw new Error("dht transport not open");
        const frame =
          typeof data === "string"
            ? encodePeerTextFrame(data)
            : encodePeerBinaryFrame(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
        current.stream.write(frame);
      },
      close: () => fireClose(),
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
        if (phase === "open") handler();
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

  return Object.assign(factory, { dispose: releaseNode });
}
