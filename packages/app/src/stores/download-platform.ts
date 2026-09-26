import { Directory, File as FSFile, Paths } from "expo-file-system";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { i18n } from "@/i18n/i18next";
import type { DownloadFolder, DownloadPlatform } from "@/stores/download-store";

// expo-modules-core derives these codes from PickerCancelledException (Android)
// and FilePickingCancelledException (iOS).
const PICKER_CANCELLED_CODES: Record<string, true> = {
  ERR_PICKER_CANCELLED: true,
  ERR_FILE_PICKING_CANCELLED: true,
};

export const downloadPlatform: DownloadPlatform = {
  async saveUrl({ url, fileName, mimeType, credentials, onProgress }) {
    const targetFile = resolveDownloadTargetFile(fileName);
    const downloadResumable = LegacyFileSystem.createDownloadResumable(
      url,
      targetFile.uri,
      credentials
        ? {
            headers: {
              Authorization: `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`,
            },
          }
        : undefined,
      (data) => onProgress(data.totalBytesWritten, data.totalBytesExpectedToWrite),
    );
    const result = await downloadResumable.downloadAsync();
    if (!result) {
      throw new Error(i18n.t("downloads.cancelled"));
    }
    return { uri: result.uri, fileName, mimeType };
  },

  async saveBytes({ bytes, fileName, mimeType }) {
    const targetFile = resolveDownloadTargetFile(fileName);
    targetFile.write(bytes);
    return { uri: targetFile.uri, fileName, mimeType };
  },

  async present({ uri, fileName, mimeType }) {
    if (!(await Sharing.isAvailableAsync())) {
      return;
    }
    await Sharing.shareAsync(uri, {
      mimeType: mimeType ?? undefined,
      dialogTitle: fileName
        ? i18n.t("downloads.shareFileNamed", { fileName })
        : i18n.t("downloads.shareFile"),
    });
  },

  async pickFolder() {
    const picked = await Directory.pickDirectoryAsync().catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && PICKER_CANCELLED_CODES[code] === true) {
        return null;
      }
      throw error;
    });
    // The declared return type is the bare native directory; wrap it like
    // expo-file-system does so list() and createFile() return JS File objects.
    return picked ? folderFor(new Directory(picked.uri)) : null;
  },
};

function folderFor(directory: Directory): DownloadFolder {
  return {
    async save({ uri, fileName, mimeType }) {
      const staged = new FSFile(uri);
      const taken = new Set(directory.list().map((entry) => entry.name));
      const target = directory.createFile(
        uniqueFileName(sanitizeDownloadFileName(fileName), (name) => taken.has(name)),
        mimeType ?? "application/octet-stream",
      );
      target.write(await staged.bytes());
      staged.delete();
    },
  };
}

function resolveDownloadTargetFile(fileName: string): FSFile {
  const directory = Paths.cache ?? Paths.document;
  if (!directory) {
    throw new Error("No download directory available.");
  }

  return new FSFile(
    directory,
    uniqueFileName(
      sanitizeDownloadFileName(fileName),
      (name) => new FSFile(directory, name).exists,
    ),
  );
}

/** `report.txt`, then `report (1).txt`, `report (2).txt`, ... until `isTaken` says no. */
function uniqueFileName(safeName: string, isTaken: (name: string) => boolean): string {
  const split = splitFileName(safeName);
  let name = safeName;
  for (let suffix = 1; isTaken(name); suffix += 1) {
    name = `${split.base} (${suffix})${split.ext}`;
  }
  return name;
}

function sanitizeDownloadFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "download";
  }
  return trimmed.replace(/[\\/:*?"<>|]+/g, "_");
}

function splitFileName(fileName: string): { base: string; ext: string } {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) {
    return { base: fileName, ext: "" };
  }
  return {
    base: fileName.slice(0, lastDot),
    ext: fileName.slice(lastDot),
  };
}
