/**
 * Persistent DHT identity seed for CLI connections over paseo-peer invites.
 *
 * The seed is 32 random bytes stored as hex in the PASEO_HOME data dir,
 * separate from the public cli-client-id. The HyperDHT node keypair derives
 * from it, so the CLI keeps one device identity across runs and reconnects.
 * Never derive this secret from the public clientId.
 *
 * Publishing writes a private temp file and hardlinks it to the final path:
 * the first concurrent creator wins, and every loser adopts the winner's seed,
 * so parallel CLI processes converge on one identity.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DHT_IDENTITY_FILE_NAME = "cli-dht-identity";
const SEED_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;
const PRIVATE_FILE_MODE = 0o600;

const seedCache = new Map<string, Buffer>();
const pendingSeeds = new Map<string, Promise<Buffer>>();

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

function decodeSeed(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!SEED_HEX_PATTERN.test(trimmed)) {
    return null;
  }
  return Buffer.from(trimmed, "hex");
}

async function readSeedFile(filePath: string): Promise<Buffer | null> {
  try {
    const seed = decodeSeed(await readFile(filePath, "utf8"));
    if (!seed)
      throw new Error(`Invalid DHT identity at ${filePath}; restore the original seed from backup`);
    return seed;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function enforcePrivateMode(filePath: string): Promise<void> {
  if (process.platform !== "win32") await chmod(filePath, PRIVATE_FILE_MODE);
}

async function publishSeedFile(filePath: string): Promise<Buffer> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const seed = randomBytes(32);
  const tempPath = join(dir, `.${DHT_IDENTITY_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, seed.toString("hex"), { mode: PRIVATE_FILE_MODE, flag: "wx" });
    try {
      // Only complete files are published. A concurrent creator keeps its seed.
      await link(tempPath, filePath);
      return seed;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const winner = await readSeedFile(filePath);
      if (!winner)
        throw new Error(`DHT identity disappeared during creation: ${filePath}`, { cause: error });
      return winner;
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function getOrCreateCliDhtSeed(): Promise<Buffer> {
  const filePath = join(
    process.env.PASEO_HOME ?? join(homedir(), ".paseo"),
    DHT_IDENTITY_FILE_NAME,
  );
  const cached = seedCache.get(filePath);
  if (cached) {
    return cached;
  }
  const pending = pendingSeeds.get(filePath);
  if (pending) {
    return pending;
  }
  const loading = (async () => {
    const existing = await readSeedFile(filePath);
    const seed = existing ?? (await publishSeedFile(filePath));
    await enforcePrivateMode(filePath);
    return seed;
  })();
  pendingSeeds.set(filePath, loading);
  try {
    const seed = await loading;
    seedCache.set(filePath, seed);
    return seed;
  } finally {
    pendingSeeds.delete(filePath);
  }
}
