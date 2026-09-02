import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type pino from "pino";
import DHT, { type HyperDhtKeyPair } from "hyperdht";
import { DHT_KEY_BYTES, encodeBase64Url } from "@getpaseo/protocol/dht-peer";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

const IdentitySchema = z.looseObject({
  v: z.literal(1),
  seedB64: z.string().min(1),
});

const IDENTITY_FILENAME = "dht-identity.json";

export interface DhtIdentity {
  /** HyperDHT (ed25519) keypair; the public key is the routing address. */
  keyPair: HyperDhtKeyPair;
  /** base64url of the public key — safe to display/log. */
  publicKeyB64: string;
}

function fromSeed(seed: Buffer): DhtIdentity {
  const keyPair = DHT.keyPair(seed);
  return { keyPair, publicKeyB64: encodeBase64Url(keyPair.publicKey) };
}

/**
 * Load the persisted HyperDHT identity, or create and persist a fresh one.
 * Stored 0600 alongside the relay keypair: the seed derives the secret key, so
 * anyone holding the file can impersonate this daemon.
 *
 * Older files also carry `capabilityB64` from when the transport ran its own
 * challenge on top of Noise. The schema is loose so those files still load and
 * keep their key — the field is simply ignored, and rewriting the file would
 * change the daemon's address and unpair every device.
 */
export function loadOrCreateDhtIdentity(paseoHome: string, logger?: pino.Logger): DhtIdentity {
  const log = logger?.child({ module: "dht-identity" });
  const filePath = path.join(paseoHome, IDENTITY_FILENAME);

  if (existsSync(filePath)) {
    try {
      ensurePrivateFile(filePath);
      const parsed = IdentitySchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
      const seed = Buffer.from(parsed.seedB64, "base64url");
      if (seed.length !== DHT_KEY_BYTES) {
        throw new Error("stored dht identity has wrong seed length");
      }
      log?.info({ filePath }, "Loaded HyperDHT identity");
      return fromSeed(seed);
    } catch (error) {
      log?.warn({ err: error, filePath }, "Failed to load HyperDHT identity, regenerating");
    }
  }

  const seed = randomBytes(DHT_KEY_BYTES);
  writePrivateFileAtomicSync(
    filePath,
    JSON.stringify({ v: 1, seedB64: seed.toString("base64url") }, null, 2) + "\n",
  );
  log?.info({ filePath }, "Saved HyperDHT identity");
  return fromSeed(seed);
}
