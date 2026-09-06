import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateCliDhtSeed } from "./dht-identity.js";

const homes: string[] = [];

describe("getOrCreateCliDhtSeed (posix)", () => {
  let home: string;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-dht-identity-"));
    homes.push(dir);
    vi.stubEnv("PASEO_HOME", dir);
    home = dir;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(homes.map((dir) => rm(dir, { recursive: true, force: true })));
    homes.length = 0;
  });

  it("writes the identity file with owner-only permissions", async () => {
    await getOrCreateCliDhtSeed();
    const { mode } = await stat(join(home, "cli-dht-identity"));
    expect(mode & 0o777).toBe(0o600);
  });

  it("tightens an existing permissive identity file to owner-only", async () => {
    const seed = Buffer.alloc(32, 9).toString("hex");
    const filePath = join(home, "cli-dht-identity");
    await writeFile(filePath, seed);
    await getOrCreateCliDhtSeed();

    const { mode } = await stat(filePath);
    expect(mode & 0o777).toBe(0o600);
  });
});
