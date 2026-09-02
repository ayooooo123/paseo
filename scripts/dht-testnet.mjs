// Ephemeral local HyperDHT testnet for demos/tests. Writes a comma-separated
// host:port bootstrap list to argv[2], then stays alive until killed.
import createTestnet from "hyperdht/testnet.js";
import { writeFileSync } from "node:fs";

const outFile = process.argv[2] ?? "/tmp/paseo-testnet-bootstrap.txt";
const testnet = await createTestnet(3);
const bootstrap = testnet.bootstrap
  .map((node) => (typeof node === "string" ? node : `${node.host}:${node.port}`))
  .join(",");
writeFileSync(outFile, bootstrap);
console.log(`testnet up: ${bootstrap}`);
setInterval(() => {}, 1_000_000);
