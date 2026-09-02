import { describe, expect, it } from "vitest";
import {
  createGitHubService,
  type GitHubCommandRunner,
  type GitHubCommandRunnerOptions,
} from "./github-service.js";

interface RunnerCall {
  args: string[];
  options: GitHubCommandRunnerOptions;
}

function createRunner(outputs: string[]): { calls: RunnerCall[]; runner: GitHubCommandRunner } {
  const calls: RunnerCall[] = [];
  return {
    calls,
    runner: async (args, options) => {
      calls.push({ args, options });
      return { stdout: outputs.shift() ?? "", stderr: "" };
    },
  };
}

describe("GitHub repository search", () => {
  it("lists recent owned repositories for an empty query and normalizes clone identity", async () => {
    const runner = createRunner([
      JSON.stringify([
        {
          id: " R_recent ",
          name: " paseo ",
          nameWithOwner: " getpaseo/paseo ",
          description: null,
          isPrivate: false,
          updatedAt: "2026-07-15T12:00:00Z",
          sshUrl: " git@github.com:getpaseo/paseo.git ",
          url: "https://github.com/getpaseo/paseo",
        },
      ]),
      "ssh\n",
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });

    await expect(
      service.searchRepositories({ cwd: "/tmp", query: "  ", limit: 8 }),
    ).resolves.toEqual([
      {
        id: "R_recent",
        name: "paseo",
        nameWithOwner: "getpaseo/paseo",
        description: null,
        visibility: "public",
        updatedAt: "2026-07-15T12:00:00Z",
        cloneUrl: "git@github.com:getpaseo/paseo.git",
      },
    ]);
    expect(runner.calls).toEqual([
      {
        args: [
          "repo",
          "list",
          "--json",
          "id,name,nameWithOwner,description,isPrivate,updatedAt,sshUrl,url",
          "--limit",
          "8",
        ],
        options: { cwd: "/tmp" },
      },
      {
        args: ["config", "get", "git_protocol", "--host", "github.com"],
        options: { cwd: "/tmp" },
      },
    ]);
  });

  it("finds a repository you own that GitHub's search index would miss", async () => {
    // The regression this guards: `gh search repos` omits forks and cannot see
    // private repositories, so a query used to return other people's projects
    // while hiding the user's own. Own repositories are filtered locally now.
    const runner = createRunner([
      JSON.stringify([
        {
          id: 42,
          name: "private-repo",
          nameWithOwner: "octo/private-repo",
          description: "Private project",
          isPrivate: true,
          updatedAt: "2026-07-14T08:00:00Z",
          sshUrl: "git@github.com:octo/private-repo.git",
          url: "https://github.com/octo/private-repo",
        },
        {
          id: 43,
          name: "unrelated",
          nameWithOwner: "octo/unrelated",
          description: null,
          isPrivate: false,
          updatedAt: "2026-07-13T08:00:00Z",
          sshUrl: "git@github.com:octo/unrelated.git",
          url: "https://github.com/octo/unrelated",
        },
      ]),
      "https",
      "[]",
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });

    await expect(
      service.searchRepositories({ cwd: "/tmp", query: " private ", limit: 5 }),
    ).resolves.toEqual([
      {
        id: "42",
        name: "private-repo",
        nameWithOwner: "octo/private-repo",
        description: "Private project",
        visibility: "private",
        updatedAt: "2026-07-14T08:00:00Z",
        cloneUrl: "https://github.com/octo/private-repo",
      },
    ]);
    expect(runner.calls[0]?.args.slice(0, 2)).toEqual(["repo", "list"]);
    // Own matches did not fill the limit, so the rest of GitHub is consulted
    // afterwards — never instead.
    expect(runner.calls.at(-1)?.args.slice(0, 3)).toEqual(["search", "repos", "private"]);
  });

  it("does not consult global search when owned repositories fill the limit", async () => {
    const runner = createRunner([
      JSON.stringify([
        {
          id: 1,
          name: "alpha",
          nameWithOwner: "octo/alpha",
          description: null,
          isPrivate: false,
          updatedAt: "2026-07-14T08:00:00Z",
          sshUrl: "git@github.com:octo/alpha.git",
          url: "https://github.com/octo/alpha",
        },
      ]),
      "https",
    ]);
    const service = createGitHubService({
      runner: runner.runner,
      resolveGhPath: async () => "/usr/bin/gh",
    });

    const results = await service.searchRepositories({ cwd: "/tmp", query: "alpha", limit: 1 });
    expect(results.map((repository) => repository.nameWithOwner)).toEqual(["octo/alpha"]);
    expect(runner.calls.some((call) => call.args[0] === "search")).toBe(false);
  });
});
