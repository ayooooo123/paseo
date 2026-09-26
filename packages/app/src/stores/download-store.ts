import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import { i18n } from "@/i18n/i18next";

interface DownloadProgress {
  percent: number;
  bytesWritten: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

export interface Download {
  id: string;
  serverId: string;
  scopeId: string;
  fileName: string;
  status: "downloading" | "complete" | "error";
  message?: string;
  progress?: DownloadProgress;
  startedAt: number;
}

export interface DownloadCredentials {
  username: string;
  password: string;
}

export interface SavedDownload {
  uri: string;
  fileName: string;
  mimeType: string | null;
}

/** Share hands the file to the share sheet (native) or browser; device saves it into a picked folder. */
export type DownloadDestination = "share" | "device";

/** A folder the user picked for "Save to device". */
export interface DownloadFolder {
  /** Copies a download saved by the platform into this folder. */
  save(saved: SavedDownload): Promise<void>;
}

/**
 * Where downloaded files land. Native writes to the cache directory and opens
 * the share sheet; web hands the file to the browser's download manager.
 */
export interface DownloadPlatform {
  /** Fetches a daemon HTTP download URL. Direct TCP connections only. */
  saveUrl(input: {
    url: string;
    fileName: string;
    mimeType: string | null;
    credentials: DownloadCredentials | null;
    onProgress: (bytesWritten: number, totalBytes: number) => void;
  }): Promise<SavedDownload>;
  /** Saves bytes that already arrived over the session connection. */
  saveBytes(input: {
    bytes: Uint8Array;
    fileName: string;
    mimeType: string;
  }): Promise<SavedDownload>;
  /** Hands a saved file to the user once the download is marked complete. */
  present(saved: SavedDownload): Promise<void>;
  /** Asks the user for a destination folder. Resolves null when they cancel. */
  pickFolder(): Promise<DownloadFolder | null>;
}

export interface StartDownloadInput {
  serverId: string;
  scopeId: string;
  fileName: string;
  path: string;
  destination: DownloadDestination;
  daemonProfile: HostProfile | undefined;
  activeConnectionId: string | null;
  requestFileDownloadToken: (path: string) => Promise<{
    token: string | null;
    fileName: string | null;
    mimeType: string | null;
    error: string | null;
  }>;
  readFile: (path: string) => Promise<FileReadResult>;
}

interface DownloadState {
  downloads: Map<string, Download>;
  activeDownloadId: string | null;

  startDownload: (input: StartDownloadInput) => Promise<void>;
  updateProgress: (id: string, progress: DownloadProgress) => void;
  completeDownload: (id: string) => void;
  failDownload: (id: string, message: string) => void;
  dismissDownload: (id: string) => void;
  dismissAllCompleted: () => void;
}

export type DownloadStore = UseBoundStore<StoreApi<DownloadState>>;

function generateDownloadId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createDownloadStore(platform: DownloadPlatform): DownloadStore {
  return create<DownloadState>()((set, get) => ({
    downloads: new Map(),
    activeDownloadId: null,

    startDownload: async ({
      serverId,
      scopeId,
      fileName,
      path,
      destination,
      daemonProfile,
      activeConnectionId,
      requestFileDownloadToken,
      readFile,
    }) => {
      const id = generateDownloadId();
      const download: Download = {
        id,
        serverId,
        scopeId,
        fileName,
        status: "downloading",
        startedAt: Date.now(),
      };

      set((state) => ({
        downloads: new Map(state.downloads).set(id, download),
        activeDownloadId: id,
      }));

      try {
        let saved: SavedDownload;
        const httpTarget = resolveDaemonHttpTarget(daemonProfile, activeConnectionId);
        if (httpTarget) {
          const tokenResponse = await requestFileDownloadToken(path);
          if (tokenResponse.error || !tokenResponse.token) {
            throw new Error(tokenResponse.error ?? i18n.t("downloads.requestTokenFailed"));
          }
          const url = new URL("/api/files/download", httpTarget.origin);
          url.searchParams.set("token", tokenResponse.token);
          const startedAt = Date.now();
          saved = await platform.saveUrl({
            url: url.toString(),
            fileName: tokenResponse.fileName ?? fileName,
            mimeType: tokenResponse.mimeType,
            credentials: httpTarget.credentials,
            onProgress: (bytesWritten, totalBytes) => {
              if (totalBytes <= 0) {
                return;
              }
              const elapsed = (Date.now() - startedAt) / 1000;
              const speed = elapsed > 0 ? bytesWritten / elapsed : 0;
              get().updateProgress(id, {
                percent: bytesWritten / totalBytes,
                bytesWritten,
                totalBytes,
                speed,
                eta: speed > 0 ? (totalBytes - bytesWritten) / speed : 0,
              });
            },
          });
        } else {
          // Relay, P2P, SSH, and local socket connections expose no HTTP endpoint
          // this client can reach, so the file streams over the session instead.
          const file = await readFile(path);
          saved = await platform.saveBytes({ bytes: file.bytes, fileName, mimeType: file.mime });
        }
        if (destination === "device") {
          // Pick only after the bytes are local: the system picker backgrounds
          // the app, and a backgrounded app drops its P2P connection.
          const folder = await platform.pickFolder();
          if (!folder) {
            get().dismissDownload(id);
            return;
          }
          await folder.save(saved);
          get().completeDownload(id);
          return;
        }
        get().completeDownload(id);
        await platform.present(saved);
      } catch (error) {
        get().failDownload(id, error instanceof Error ? error.message : i18n.t("downloads.failed"));
      }
    },

    updateProgress: (id, progress) => {
      set((state) => {
        const download = state.downloads.get(id);
        if (!download || download.status !== "downloading") {
          return state;
        }
        const updated = new Map(state.downloads);
        updated.set(id, { ...download, progress });
        return { downloads: updated };
      });
    },

    completeDownload: (id) => {
      set((state) => {
        const download = state.downloads.get(id);
        if (!download) {
          return state;
        }
        const updated = new Map(state.downloads);
        updated.set(id, { ...download, status: "complete" });
        return { downloads: updated };
      });
    },

    failDownload: (id, message) => {
      set((state) => {
        const download = state.downloads.get(id);
        if (!download) {
          return state;
        }
        const updated = new Map(state.downloads);
        updated.set(id, { ...download, status: "error", message });
        return { downloads: updated };
      });
    },

    dismissDownload: (id) => {
      set((state) => {
        const updated = new Map(state.downloads);
        updated.delete(id);
        const newActiveId =
          state.activeDownloadId === id
            ? findMostRecentDownloadId(updated)
            : state.activeDownloadId;
        return { downloads: updated, activeDownloadId: newActiveId };
      });
    },

    dismissAllCompleted: () => {
      set((state) => {
        const updated = new Map(state.downloads);
        for (const [id, download] of updated) {
          if (download.status !== "downloading") {
            updated.delete(id);
          }
        }
        let newActiveId: string | null;
        if (!state.activeDownloadId) newActiveId = null;
        else if (updated.has(state.activeDownloadId)) newActiveId = state.activeDownloadId;
        else newActiveId = findMostRecentDownloadId(updated);
        return { downloads: updated, activeDownloadId: newActiveId };
      });
    },
  }));
}

function findMostRecentDownloadId(downloads: Map<string, Download>): string | null {
  let mostRecent: Download | null = null;
  for (const download of downloads.values()) {
    if (!mostRecent || download.startedAt > mostRecent.startedAt) {
      mostRecent = download;
    }
  }
  return mostRecent?.id ?? null;
}

/**
 * Returns the daemon's HTTP origin when the client is connected over direct
 * TCP right now. A saved direct TCP address is not enough: while the active
 * connection is the relay, that address is usually unreachable (a LAN IP seen
 * from outside the LAN).
 */
function resolveDaemonHttpTarget(
  daemon: HostProfile | undefined,
  activeConnectionId: string | null,
): { origin: string; credentials: DownloadCredentials | null } | null {
  const connection = daemon?.connections.find((conn) => conn.id === activeConnectionId);
  if (connection?.type !== "directTcp") {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(
      buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
    );
  } catch {
    return null;
  }

  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  const credentials =
    parsed.username || parsed.password
      ? {
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        }
      : null;

  return { origin: parsed.origin, credentials };
}

export function formatSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  if (bytesPerSecond < 1024 * 1024) {
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
  }
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatEta(seconds: number): string {
  if (seconds < 1) {
    return "< 1s";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}
