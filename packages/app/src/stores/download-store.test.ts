import { describe, expect, it } from "vitest";
import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import { defaultHostAppearance } from "@/hosts/appearance";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import {
  createDownloadStore,
  type DownloadDestination,
  type DownloadPlatform,
  type DownloadStore,
  type SavedDownload,
  type StartDownloadInput,
} from "./download-store";

const RELAY: HostConnection = {
  id: "relay:relay.paseo.sh:443",
  type: "relay",
  relayEndpoint: "relay.paseo.sh:443",
  daemonPublicKeyB64: "daemon-public-key",
};
const LAN: HostConnection = {
  id: "direct:192.168.1.5:6767",
  type: "directTcp",
  endpoint: "192.168.1.5:6767",
};

function hostWith(connections: HostConnection[]): HostProfile {
  return {
    serverId: "srv",
    label: "Studio Mac",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: connections[0]?.id ?? null,
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
  };
}

type PlatformCall =
  | { kind: "saveUrl"; url: string; fileName: string }
  | { kind: "saveBytes"; text: string; fileName: string; mimeType: string }
  | { kind: "present"; saved: SavedDownload }
  | { kind: "pickFolder" }
  | { kind: "saveToFolder"; folder: string; saved: SavedDownload };

function createRecordingPlatform(
  options: { urlProgress?: [number, number]; pickedFolder?: string | null } = {},
) {
  const calls: PlatformCall[] = [];
  const platform: DownloadPlatform = {
    async saveUrl({ url, fileName, mimeType, onProgress }) {
      calls.push({ kind: "saveUrl", url, fileName });
      if (options.urlProgress) onProgress(...options.urlProgress);
      return { uri: `file:///cache/${fileName}`, fileName, mimeType };
    },
    async saveBytes({ bytes, fileName, mimeType }) {
      calls.push({ kind: "saveBytes", text: new TextDecoder().decode(bytes), fileName, mimeType });
      return { uri: `file:///cache/${fileName}`, fileName, mimeType };
    },
    async present(saved) {
      calls.push({ kind: "present", saved });
    },
    async pickFolder() {
      calls.push({ kind: "pickFolder" });
      const folder = options.pickedFolder;
      if (!folder) return null;
      return {
        async save(saved) {
          calls.push({ kind: "saveToFolder", folder, saved });
        },
      };
    },
  };
  return { platform, calls };
}

interface DaemonFiles extends Pick<StartDownloadInput, "requestFileDownloadToken" | "readFile"> {
  tokenRequests: string[];
  reads: string[];
}

function createDaemonFiles(contents: Record<string, string>): DaemonFiles {
  const tokenRequests: string[] = [];
  const reads: string[] = [];
  return {
    tokenRequests,
    reads,
    requestFileDownloadToken: async (path: string) => {
      tokenRequests.push(path);
      return { token: "tok-1", fileName: path, mimeType: "text/plain", error: null };
    },
    readFile: async (path: string): Promise<FileReadResult> => {
      reads.push(path);
      const text = contents[path];
      if (text === undefined) throw new Error(`File not found: ${path}`);
      const bytes = new TextEncoder().encode(text);
      return {
        bytes,
        mime: "text/plain",
        size: bytes.byteLength,
        path,
        kind: "text",
        modifiedAt: "2026-09-25T00:00:00.000Z",
      };
    },
  };
}

function downloadInput(
  host: HostProfile,
  activeConnectionId: string,
  daemon: DaemonFiles,
  options: { path?: string; destination?: DownloadDestination } = {},
): StartDownloadInput {
  const path = options.path ?? "report.txt";
  return {
    serverId: host.serverId,
    scopeId: "workspace-1",
    fileName: path,
    path,
    destination: options.destination ?? "share",
    daemonProfile: host,
    activeConnectionId,
    requestFileDownloadToken: daemon.requestFileDownloadToken,
    readFile: daemon.readFile,
  };
}

function onlyDownload(store: DownloadStore) {
  const downloads = [...store.getState().downloads.values()];
  expect(downloads).toHaveLength(1);
  return downloads[0];
}

describe("download store routing", () => {
  it("streams the file over the session when the host is reachable only through the relay", async () => {
    const { platform, calls } = createRecordingPlatform();
    const store = createDownloadStore(platform);
    const daemon = createDaemonFiles({ "report.txt": "quarterly numbers" });

    await store.getState().startDownload(downloadInput(hostWith([RELAY]), RELAY.id, daemon));

    expect(onlyDownload(store)).toMatchObject({ status: "complete" });
    expect(daemon.tokenRequests).toEqual([]);
    expect(calls).toEqual([
      {
        kind: "saveBytes",
        text: "quarterly numbers",
        fileName: "report.txt",
        mimeType: "text/plain",
      },
      {
        kind: "present",
        saved: { uri: "file:///cache/report.txt", fileName: "report.txt", mimeType: "text/plain" },
      },
    ]);
  });

  it("ignores a saved LAN address while the active connection is the relay", async () => {
    const { platform, calls } = createRecordingPlatform();
    const store = createDownloadStore(platform);
    const daemon = createDaemonFiles({ "report.txt": "quarterly numbers" });

    await store.getState().startDownload(downloadInput(hostWith([LAN, RELAY]), RELAY.id, daemon));

    expect(onlyDownload(store)).toMatchObject({ status: "complete" });
    expect(daemon.tokenRequests).toEqual([]);
    expect(calls.map((call) => call.kind)).toEqual(["saveBytes", "present"]);
  });

  it("downloads over the daemon HTTP endpoint while connected over direct TCP", async () => {
    const { platform, calls } = createRecordingPlatform({ urlProgress: [512, 1024] });
    const store = createDownloadStore(platform);
    const daemon = createDaemonFiles({});

    await store.getState().startDownload(downloadInput(hostWith([LAN, RELAY]), LAN.id, daemon));

    const download = onlyDownload(store);
    expect(download).toMatchObject({
      status: "complete",
      progress: { percent: 0.5, bytesWritten: 512, totalBytes: 1024 },
    });
    expect(daemon.reads).toEqual([]);
    expect(calls).toEqual([
      {
        kind: "saveUrl",
        url: "http://192.168.1.5:6767/api/files/download?token=tok-1",
        fileName: "report.txt",
      },
      {
        kind: "present",
        saved: { uri: "file:///cache/report.txt", fileName: "report.txt", mimeType: "text/plain" },
      },
    ]);
  });

  it("reports a session stream failure on the download without presenting anything", async () => {
    const { platform, calls } = createRecordingPlatform();
    const store = createDownloadStore(platform);
    const daemon = createDaemonFiles({});

    await store
      .getState()
      .startDownload(downloadInput(hostWith([RELAY]), RELAY.id, daemon, { path: "missing.txt" }));

    expect(onlyDownload(store)).toMatchObject({
      status: "error",
      message: "File not found: missing.txt",
    });
    expect(calls).toEqual([]);
  });
});

describe("save to device", () => {
  // The system folder picker backgrounds the app, and a backgrounded app drops
  // its P2P connection, so the bytes must be local before the picker opens.
  it("downloads first, then asks for a folder and saves the file there instead of sharing", async () => {
    const { platform, calls } = createRecordingPlatform({ pickedFolder: "Documents" });
    const store = createDownloadStore(platform);
    const daemon = createDaemonFiles({ "report.txt": "quarterly numbers" });

    await store
      .getState()
      .startDownload(downloadInput(hostWith([RELAY]), RELAY.id, daemon, { destination: "device" }));

    expect(onlyDownload(store)).toMatchObject({ status: "complete" });
    expect(calls).toEqual([
      {
        kind: "saveBytes",
        text: "quarterly numbers",
        fileName: "report.txt",
        mimeType: "text/plain",
      },
      { kind: "pickFolder" },
      {
        kind: "saveToFolder",
        folder: "Documents",
        saved: { uri: "file:///cache/report.txt", fileName: "report.txt", mimeType: "text/plain" },
      },
    ]);
  });

  it("removes the download and saves nothing when the folder picker is cancelled", async () => {
    const { platform, calls } = createRecordingPlatform({ pickedFolder: null });
    const store = createDownloadStore(platform);
    const daemon = createDaemonFiles({});

    await store
      .getState()
      .startDownload(downloadInput(hostWith([LAN]), LAN.id, daemon, { destination: "device" }));

    expect(store.getState().downloads.size).toBe(0);
    expect(store.getState().activeDownloadId).toBeNull();
    expect(calls.map((call) => call.kind)).toEqual(["saveUrl", "pickFolder"]);
  });
});
