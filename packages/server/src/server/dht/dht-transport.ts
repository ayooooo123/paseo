import { EventEmitter } from "node:events";
import type pino from "pino";
import DHT, { type HyperDhtKeyPair, type HyperDhtServer, type HyperDhtStream } from "hyperdht";
import {
  PeerFrameDecoder,
  PEER_FRAME_CONTROL,
  PEER_FRAME_TEXT,
  PEER_FRAME_BINARY,
  encodeBase64Url,
  encodePeerBinaryFrame,
  encodePeerTextFrame,
} from "@getpaseo/protocol/dht-peer";
import type { WebSocketLike, ExternalSocketMetadata } from "../websocket-server.js";

type AttachSocket = (ws: WebSocketLike, metadata?: ExternalSocketMetadata) => Promise<void>;

/**
 * Adapt an authorized HyperDHT Noise stream to the daemon's `WebSocketLike`.
 * Inbound application frames are buffered until the consumer binds a `message`
 * listener (the attach race the relay solves with `pendingMessages`), and a peer
 * FIN (`end`) or teardown (`close`) both surface as the WebSocket-close analog.
 */
interface DhtWebSocketBridge {
  socket: WebSocketLike;
  flush: () => void;
  deliver: (type: number, payload: Uint8Array) => void;
}

function dhtStreamToWebSocketLike(stream: HyperDhtStream): DhtWebSocketBridge {
  const emitter = new EventEmitter();
  let readyState = 1;
  let flushed = false;
  const pending: Array<[string | ArrayBuffer, boolean]> = [];

  const emitMessage = (data: string | ArrayBuffer, isBinary: boolean): void => {
    if (flushed) emitter.emit("message", data, isBinary);
    else pending.push([data, isBinary]);
  };
  const flush = (): void => {
    if (flushed) return;
    flushed = true;
    for (const [data, isBinary] of pending) emitter.emit("message", data, isBinary);
    pending.length = 0;
  };

  const onClose = (): void => {
    if (readyState === 3) return;
    readyState = 3;
    emitter.emit("close", 1006, "stream closed");
  };
  stream.on("end", onClose);
  stream.on("close", onClose);
  stream.on("error", (error) => {
    if (emitter.listenerCount("error") > 0) emitter.emit("error", error);
  });

  const socket: WebSocketLike = {
    get readyState() {
      return readyState;
    },
    get bufferedAmount() {
      return stream.writableLength ?? 0;
    },
    send(data, callback) {
      if (readyState !== 1) {
        callback?.(new Error("dht socket is not open"));
        return;
      }
      try {
        const frame =
          typeof data === "string"
            ? encodePeerTextFrame(data)
            : encodePeerBinaryFrame(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
        stream.write(frame, (error) => callback?.(error ?? undefined));
      } catch (error) {
        callback?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    close() {
      if (readyState === 3) return;
      readyState = 3;
      try {
        stream.end();
      } catch {
        // ignore
      }
    },
    terminate() {
      if (readyState === 3) return;
      readyState = 3;
      try {
        stream.destroy();
      } catch {
        // ignore
      }
    },
    on(event, listener) {
      emitter.on(event, listener);
      if (event === "message") flush();
    },
    once(event, listener) {
      emitter.once(event, listener);
    },
  };

  const deliver = (type: number, payload: Uint8Array): void => {
    if (type === PEER_FRAME_TEXT) {
      emitMessage(new TextDecoder("utf-8", { fatal: false }).decode(payload), false);
    } else if (type === PEER_FRAME_BINARY) {
      // slice() already produces an exact-length buffer; copying it again
      // doubled the cost of every binary message.
      emitMessage(payload.slice().buffer, true);
    }
  };

  return { socket, flush, deliver };
}

export interface DhtHostOptions {
  dht: DHT;
  keyPair: HyperDhtKeyPair;
  attachSocket: AttachSocket;
  logger: pino.Logger;
}

export interface DhtHost {
  listen(): Promise<void>;
  close(): Promise<void>;
  connectionCount(): number;
}

/**
 * HyperDHT peer host: listens on the identity keypair and bridges each accepted
 * stream into the daemon via `attachSocket`.
 *
 * A stream only exists once HyperDHT has completed a Noise handshake against
 * this keypair, so the peer has already proven it knows the public key and the
 * daemon has already proven it holds the secret key. `remotePublicKey` is the
 * dialing device's own key, logged as a fingerprint so paired devices are
 * distinguishable in the daemon log.
 */
export function createDhtHost(options: DhtHostOptions): DhtHost {
  const { dht, keyPair, attachSocket, logger } = options;
  const log = logger.child({ module: "dht-host" });
  const active = new Set<HyperDhtStream>();
  let server: HyperDhtServer | null = null;

  const onConnection = (stream: HyperDhtStream): void => {
    active.add(stream);
    stream.on("close", () => active.delete(stream));

    const remotePublicKey = stream.remotePublicKey;
    const peer = remotePublicKey ? encodeBase64Url(remotePublicKey).slice(0, 12) : "unknown";
    const bridge = dhtStreamToWebSocketLike(stream);
    const decoder = new PeerFrameDecoder();

    // The bridge owns the stream from here, so a stream error has to tear down
    // what it owns rather than being swallowed.
    stream.on("error", (error) => {
      log.warn({ err: error, peer }, "dht_peer_stream_error");
    });

    stream.on("data", (chunk) => {
      let frames;
      try {
        frames = decoder.push(chunk);
      } catch {
        stream.destroy();
        return;
      }
      for (const { type, payload } of frames) {
        if (type !== PEER_FRAME_CONTROL) bridge.deliver(type, payload);
      }
    });

    log.info({ peer }, "dht_peer_connected");
    void Promise.resolve(attachSocket(bridge.socket, { transport: "hyperdht" }))
      .then(() => bridge.flush())
      .catch((error) => {
        log.warn({ err: error, peer }, "dht_attach_failed");
        stream.destroy();
      });
  };

  return {
    async listen() {
      const created = dht.createServer({ reusableSocket: true });
      created.on("connection", onConnection);
      await created.listen(keyPair);
      server = created;
      log.info(
        { publicKeyB64: encodeBase64Url(keyPair.publicKey).slice(0, 12) },
        "dht_host_listening",
      );
    },
    async close() {
      for (const stream of active) {
        try {
          stream.destroy();
        } catch {
          // ignore
        }
      }
      active.clear();
      await server?.close();
      server = null;
    },
    connectionCount() {
      return active.size;
    },
  };
}
