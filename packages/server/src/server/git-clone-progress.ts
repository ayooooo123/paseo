import type { ProjectGithubCloneProgressPhase } from "@getpaseo/protocol/messages";

/** The clone progress message rejects longer detail strings. */
const MAX_DETAIL_LENGTH = 200;

export interface GitCloneProgressUpdate {
  phase: ProjectGithubCloneProgressPhase;
  percent: number | null;
  detail: string | null;
}

/**
 * The phase labels `git clone --progress` writes to stderr. Everything else git
 * says while cloning (`Enumerating objects`, remote banners, warnings) carries
 * no progress and is dropped.
 */
const PHASE_LABELS: readonly (readonly [string, ProjectGithubCloneProgressPhase])[] = [
  ["Counting objects", "counting"],
  ["Compressing objects", "compressing"],
  ["Receiving objects", "receiving"],
  ["Resolving deltas", "resolving"],
  ["Updating files", "checkout"],
  ["Checking out files", "checkout"],
];

const REMOTE_PREFIX_PATTERN = /^remote:\s*/u;
const PERCENT_PATTERN = /(\d+(?:\.\d+)?)\s*%/u;
/** `245.55 MiB | 2.10 MiB/s` — a byte count, optionally trailed by a rate. */
const SIZE_PATTERN = /\d+(?:\.\d+)?\s*(?:[KMGTP]i?B|bytes)/iu;

/**
 * Parse one stderr chunk of `git clone --progress` output into a progress
 * update. Git separates in-place updates with `\r`, so a single chunk carries
 * many stale updates; only the newest recognised one is reported. Returns
 * `null` when the chunk says nothing about progress.
 */
export function parseGitCloneProgress(text: string): GitCloneProgressUpdate | null {
  const segments = text.split(/[\r\n]+/u);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined || segment.trim() === "") continue;
    const update = parseProgressSegment(segment);
    if (update) return update;
  }
  return null;
}

function parseProgressSegment(segment: string): GitCloneProgressUpdate | null {
  const line = segment.replace(REMOTE_PREFIX_PATTERN, "").trim();
  for (const [label, phase] of PHASE_LABELS) {
    if (!line.startsWith(`${label}:`)) continue;
    const rest = line.slice(label.length + 1);
    return { phase, percent: parsePercent(rest), detail: parseDetail(rest) };
  }
  return null;
}

function parsePercent(rest: string): number | null {
  const match = PERCENT_PATTERN.exec(rest);
  if (!match?.[1]) return null;
  const percent = Number.parseFloat(match[1]);
  if (!Number.isFinite(percent)) return null;
  // The wire schema only accepts 0..100; git rounding must not fail validation.
  return Math.min(100, Math.max(0, percent));
}

function parseDetail(rest: string): string | null {
  const parts = rest.split(",");
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const candidate = parts[index]?.trim();
    if (candidate && SIZE_PATTERN.test(candidate)) {
      return candidate.slice(0, MAX_DETAIL_LENGTH);
    }
  }
  return null;
}
