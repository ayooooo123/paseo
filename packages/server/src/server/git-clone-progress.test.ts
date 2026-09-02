import { describe, expect, test } from "vitest";
import { parseGitCloneProgress } from "./git-clone-progress.js";

describe("parseGitCloneProgress", () => {
  test.each([
    [
      "remote: Counting objects:  34% (100/292), done.",
      { phase: "counting", percent: 34, detail: null },
    ],
    [
      "remote: Compressing objects:  55% (60/109)",
      { phase: "compressing", percent: 55, detail: null },
    ],
    [
      "Receiving objects:  42% (123/292), 245.55 MiB | 2.10 MiB/s",
      { phase: "receiving", percent: 42, detail: "245.55 MiB | 2.10 MiB/s" },
    ],
    ["Resolving deltas:  71% (139/195)", { phase: "resolving", percent: 71, detail: null }],
    ["Updating files:  62% (1234/1987)", { phase: "checkout", percent: 62, detail: null }],
    ["Checking out files:  62% (1234/1987)", { phase: "checkout", percent: 62, detail: null }],
  ] as const)("parses %s", (line, expected) => {
    expect(parseGitCloneProgress(line)).toEqual(expected);
  });

  test("reports the newest update in a carriage-return packed chunk", () => {
    const chunk =
      "Receiving objects:  40% (117/292), 240.00 MiB | 2.00 MiB/s\r" +
      "Receiving objects:  41% (120/292), 242.00 MiB | 2.05 MiB/s\r" +
      "Receiving objects:  42% (123/292), 245.55 MiB | 2.10 MiB/s\r";
    expect(parseGitCloneProgress(chunk)).toEqual({
      phase: "receiving",
      percent: 42,
      detail: "245.55 MiB | 2.10 MiB/s",
    });
  });

  test("skips trailing lines that carry no progress", () => {
    const chunk =
      "Resolving deltas:  71% (139/195)\rremote: Enumerating objects: 292, done.\nwarning: whatever\n";
    expect(parseGitCloneProgress(chunk)).toEqual({
      phase: "resolving",
      percent: 71,
      detail: null,
    });
  });

  test("reports a null percent when git does not quantify the phase", () => {
    expect(parseGitCloneProgress("Receiving objects: 1234, 245.55 MiB | 2.10 MiB/s")).toEqual({
      phase: "receiving",
      percent: null,
      detail: "245.55 MiB | 2.10 MiB/s",
    });
  });

  test.each([
    "remote: Enumerating objects: 292, done.",
    "Cloning into '/tmp/paseo-clone-abc'...",
    "",
  ])("returns null for unrecognised output %j", (line) => {
    expect(parseGitCloneProgress(line)).toBeNull();
  });
});
