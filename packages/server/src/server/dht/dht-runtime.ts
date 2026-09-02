import type pino from "pino";
import DHT from "hyperdht";
import { encodePeerInvite } from "@getpaseo/protocol/dht-peer";
import type { WebSocketLike, ExternalSocketMetadata } from "../websocket-server.js";
import type { DhtIdentity } from "./dht-identity.js";
import { createDhtHost, type DhtHost } from "./dht-transport.js";

type AttachSocket = (ws: WebSocketLike, metadata?: ExternalSocketMetadata) => Promise<void>;

export interface DhtRuntimeStatus {
  enabled: boolean;
  listening: boolean;
  publicKeyB64: string;
  connections: number;
}

export interface DhtRuntimeOptions {
  enabled: boolean;
  identity: DhtIdentity;
  attachSocket: AttachSocket;
  logger: pino.Logger;
  /** Optional bootstrap override (e.g. a testnet); defaults to the public DHT. */
  bootstrap?: readonly string[];
  createDht?: (bootstrap?: readonly string[]) => DHT;
}

export interface DhtRuntime {
  /** The pairing invite: this daemon's public key. Bearer grant — expose deliberately. */
  getInvite(): string;
  getStatus(): DhtRuntimeStatus;
  setEnabled(enabled: boolean): void;
  stop(): Promise<void>;
  /** Resolves once the DHT server has announced and is accepting connections. */
  whenListening(): Promise<void>;
}

export function createDhtRuntime(options: DhtRuntimeOptions): DhtRuntime {
  const { identity, attachSocket, logger, bootstrap } = options;
  const log = logger.child({ module: "dht-runtime" });
  const createDht = options.createDht ?? ((bs) => new DHT(bs ? { bootstrap: [...bs] } : undefined));
  const invite = encodePeerInvite({ publicKey: identity.keyPair.publicKey });

  let enabled = options.enabled;
  let dht: DHT | null = null;
  let host: DhtHost | null = null;
  let listenPromise: Promise<void> = Promise.resolve();

  function start(): void {
    if (host) return;
    const node = createDht(bootstrap);
    const created = createDhtHost({
      dht: node,
      keyPair: identity.keyPair,
      attachSocket,
      logger,
    });
    dht = node;
    host = created;
    listenPromise = created.listen().catch((error) => {
      log.warn({ err: error }, "dht_listen_failed");
    });
    void listenPromise;
  }

  async function teardown(): Promise<void> {
    const currentHost = host;
    const currentDht = dht;
    host = null;
    dht = null;
    await currentHost?.close().catch((error) => log.warn({ err: error }, "dht_host_close_failed"));
    await currentDht?.destroy().catch((error) => log.warn({ err: error }, "dht_destroy_failed"));
  }

  function setEnabled(next: boolean): void {
    if (enabled === next) return;
    enabled = next;
    if (next) start();
    else void teardown();
  }

  if (enabled) start();

  return {
    getInvite: () => invite,
    getStatus: () => ({
      enabled,
      listening: host !== null,
      publicKeyB64: identity.publicKeyB64,
      connections: host?.connectionCount() ?? 0,
    }),
    setEnabled,
    stop: teardown,
    whenListening: () => listenPromise,
  };
}
