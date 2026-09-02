/**
 * HyperDHT client transport for the Node/desktop daemon client.
 *
 * Produces a `DaemonTransportFactory` that dials a daemon by its
 * `paseo-peer://v1/...` invite and presents the Noise stream as a
 * `DaemonTransport`. HyperDHT authenticates the dial itself, so the transport is
 * open as soon as the stream is. This module imports `hyperdht`, so it is
 * Node-only and must never be pulled into the React Native bundle (the mobile
 * app uses a Bare worker instead).
 */
import DHT, { type HyperDhtStream } from "hyperdht";
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
import type { DaemonTransport, DaemonTransportFactory } from "./daemon-client-transport-types.js";

export interface DhtTransportOptions {
  invite: string;
  /** Optional bootstrap override (e.g. a testnet); defaults to the public DHT. */
  bootstrap?: readonly string[];
  createDht?: () => DHT;
}

type MessageHandler = (data: unknown, isBinary: boolean) => void;
type VoidHandler = () => void;
type EventHandler = (event?: unknown) => void;

export function createDhtTransportFactory(options: DhtTransportOptions): DaemonTransportFactory {
  const { publicKey } = decodePeerInvite(options.invite);

  return (): DaemonTransport => {
    const dht =
      options.createDht?.() ??
      new DHT(options.bootstrap ? { bootstrap: [...options.bootstrap] } : undefined);

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
    const startDial = (): void => {
      dialAttempt += 1;
      const attempt = { stream: dht.connect(publicKey), dead: false };
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
            // slice() already produces an exact-length buffer; copying it
            // again doubled the cost of every binary message.
            deliver(payload.slice().buffer, true);
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
        const code = (error as { code?: unknown }).code;
        if (
          phase === "connecting" &&
          dialAttempt < DHT_DIAL_MAX_ATTEMPTS &&
          DHT_DIAL_TRANSIENT_CODES[code as string] === true
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
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (phase === "connecting") startDial();
          }, DHT_DIAL_RETRY_BASE_MS * dialAttempt);
          return;
        }
        for (const handler of errorHandlers) handler(error);
      });
    };

    const fireClose = (event?: unknown): void => {
      if (phase === "closed") return;
      phase = "closed";
      for (const handler of closeHandlers) handler(event);
      void dht.destroy().catch(() => undefined);
    };
    const deliver = (data: unknown, isBinary: boolean): void => {
      if (messageHandlers.size === 0) {
        pending.push([data, isBinary]);
        return;
      }
      for (const handler of messageHandlers) handler(data, isBinary);
    };

    startDial();
    return {
      send: (data) => {
        if (phase !== "open" || !current) throw new Error("dht transport not open");
        const frame =
          typeof data === "string"
            ? encodePeerTextFrame(data)
            : encodePeerBinaryFrame(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
        current.stream.write(frame);
      },
      close: () => {
        if (phase === "closed") return;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        const attempt = current;
        if (phase === "open" && attempt) {
          try {
            attempt.stream.end();
          } catch {
            // ignore
          }
          // The close event fires fireClose, as before.
          return;
        }
        // Mid-dial cancel: no close event is guaranteed from a half-open
        // socket, so destroy the attempt and close out synchronously.
        if (attempt) {
          attempt.dead = true;
          current = null;
          try {
            attempt.stream.destroy();
          } catch {
            // ignore
          }
        }
        fireClose();
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
}
