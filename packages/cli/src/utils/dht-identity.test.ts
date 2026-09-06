import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateCliDhtSeed } from "./dht-identity.js";

const identityFileName = "cli-dht-identity";
const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "paseo-dht-identity-"));
  homes.push(home);
  return home;
}

describe("getOrCreateCliDhtSeed", () => {
  let home: string;

  beforeEach(async () => {
    home = await tempHome();
    vi.stubEnv("PASEO_HOME", home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(homes.map((dir) => rm(dir, { recursive: true, force: true })));
    homes.length = 0;
  });

  it("writes a 32-byte hex seed file and returns the same seed on later calls", async () => {
    const first = await getOrCreateCliDhtSeed();
    expect(first).toHaveLength(32);

    const stored = (await readFile(join(home, identityFileName), "utf8")).trim();
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(stored, "hex")).toEqual(first);

    expect(await getOrCreateCliDhtSeed()).toEqual(first);
  });

  it("keeps seeds independent per PASEO_HOME", async () => {
    const firstHome = await getOrCreateCliDhtSeed();
    const other = await tempHome();
    vi.stubEnv("PASEO_HOME", other);

    const otherSeed = await getOrCreateCliDhtSeed();
    expect(otherSeed).not.toEqual(firstHome);
    expect(await getOrCreateCliDhtSeed()).toEqual(otherSeed);

    vi.stubEnv("PASEO_HOME", home);
    expect(await getOrCreateCliDhtSeed()).toEqual(firstHome);
  });

  it("adopts an existing valid seed file", async () => {
    const known = Buffer.alloc(32, 7).toString("hex");
    await writeFile(join(home, identityFileName), `${known}\n`);
    expect(await getOrCreateCliDhtSeed()).toEqual(Buffer.alloc(32, 7));
  });

  it("rejects a corrupt seed without silently changing the device identity", async () => {
    const path = join(home, identityFileName);
    await writeFile(path, "not-a-seed");
    await expect(getOrCreateCliDhtSeed()).rejects.toThrow("Invalid DHT identity");
    expect(await readFile(path, "utf8")).toBe("not-a-seed");
    expect(await readdir(home)).toEqual([identityFileName]);
  });
});
