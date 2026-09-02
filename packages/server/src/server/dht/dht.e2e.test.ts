import { afterEach, describe, expect, it } from "vitest";
import DHT from "hyperdht";
import createTestnet from "hyperdht/testnet.js";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createDhtTransportFactory } from "@getpaseo/client/internal/dht-transport";
import { encodePeerInvite } from "@getpaseo/protocol/dht-peer";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { loadOrCreateDhtIdentity } from "./dht-identity.js";

interface Testnet {
  readonly bootstrap: string[];
  destroy(): Promise<void>;
}

describe("hyperdht peer transport end-to-end", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup().catch(() => undefined);
  });

  async function setup(): Promise<{ testnet: Testnet; daemon: TestPaseoDaemon; invite: string }> {
    const testnet = (await createTestnet(4)) as Testnet;
    cleanups.push(() => testnet.destroy());
    // dhtBlockingListen makes the daemon await its DHT announce before reporting
    // ready, so a client that dials right after setup finds the peer immediately.
    const daemon = await createTestPaseoDaemon({
      dhtEnabled: true,
      dhtBootstrap: testnet.bootstrap,
      dhtBlockingListen: true,
    });
    cleanups.push(() => daemon.close());
    const identity = loadOrCreateDhtIdentity(daemon.paseoHome);
    const invite = encodePeerInvite({ publicKey: identity.keyPair.publicKey });
    return { testnet, daemon, invite };
  }

  it("connects a daemon client over HyperDHT and completes a real RPC round-trip", async () => {
    const { testnet, invite } = await setup();
    const client = new DaemonClient({
      url: "ws://hyperdht.invalid/ws",
      clientId: "dht-e2e-client",
      clientType: "cli",
      reconnect: { enabled: false },
      connectTimeoutMs: 20_000,
      transportFactory: createDhtTransportFactory({ invite, bootstrap: testnet.bootstrap }),
    });
    cleanups.push(() => client.close());

    await client.connect();

    expect(client.isConnected).toBe(true);
    // Proves the Paseo hello handshake + server_info flowed over the DHT stream.
    expect(client.getLastServerInfoMessage()?.serverId).toBeTruthy();

    // Proves a bidirectional session RPC round-trips over the transport.
    const agents = await client.fetchAgents();
    expect(agents).toBeTruthy();
    expect(Array.isArray(agents.entries)).toBe(true);
  }, 40_000);

  // Authorization is the Noise handshake: a dial only completes against the
  // daemon holding the secret half of the dialed key. An invite for any other
  // key reaches no daemon at all, which is what replaces the old capability
  // challenge.
  it("never connects with an invite for a different key", async () => {
    const { testnet } = await setup();
    const stranger = encodePeerInvite({ publicKey: DHT.keyPair().publicKey });

    const client = new DaemonClient({
      url: "ws://hyperdht.invalid/ws",
      clientId: "dht-e2e-stranger",
      clientType: "cli",
      reconnect: { enabled: false },
      connectTimeoutMs: 5_000,
      transportFactory: createDhtTransportFactory({
        invite: stranger,
        bootstrap: testnet.bootstrap,
      }),
    });
    cleanups.push(() => client.close());

    await expect(client.connect()).rejects.toThrow();
    expect(client.isConnected).toBe(false);
    expect(client.getLastServerInfoMessage()).toBeNull();
  }, 40_000);
});
