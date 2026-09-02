import fs from "node:fs";
import DHT from "hyperdht";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createDhtTransportFactory } from "@getpaseo/client/internal/dht-transport";
import { encodePeerInvite } from "@getpaseo/protocol/dht-peer";

const home = process.argv[2];
const id = JSON.parse(fs.readFileSync(`${home}/dht-identity.json`, "utf8"));
const kp = DHT.keyPair(Buffer.from(id.seedB64, "base64url"));
const invite = encodePeerInvite({
  publicKey: kp.publicKey,
  capability: Buffer.from(id.capabilityB64, "base64url"),
});

const client = new DaemonClient({
  url: "ws://hyperdht.invalid/ws",
  clientId: `xproc-${Date.now()}`,
  clientType: "cli",
  reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 3000 },
  connectTimeoutMs: 20000,
  transportFactory: createDhtTransportFactory({ invite }),
});

const t0 = Date.now();
client.connect().catch(() => {});
const deadline = Date.now() + 80000;
while (!client.isConnected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
if (!client.isConnected) {
  console.log("NOT CONNECTED");
  process.exit(2);
}
console.log(
  `CONNECTED over DHT in ${((Date.now() - t0) / 1000).toFixed(1)}s; serverId=${client.getLastServerInfoMessage()?.serverId}`,
);
const agents = await client.fetchAgents();
console.log(`fetchAgents OK; entries=${agents.entries.length}`);
await client.close();
process.exit(0);
