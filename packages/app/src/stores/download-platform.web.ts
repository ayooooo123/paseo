import type { DownloadPlatform } from "@/stores/download-store";
import { openExternalUrl } from "@/utils/open-external-url";

// Long enough for the browser to start reading the blob after the click.
const BLOB_URL_REVOKE_DELAY_MS = 60_000;

export const downloadPlatform: DownloadPlatform = {
  async saveUrl({ url, fileName, mimeType, credentials }) {
    const downloadUrl = new URL(url);
    if (credentials) {
      downloadUrl.username = credentials.username;
      downloadUrl.password = credentials.password;
    }
    triggerBrowserDownload(downloadUrl.toString(), fileName);
    return { uri: downloadUrl.toString(), fileName, mimeType };
  },

  async saveBytes({ bytes, fileName, mimeType }) {
    // slice() narrows the buffer to ArrayBuffer, which BlobPart requires.
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: mimeType }));
    triggerBrowserDownload(url, fileName);
    setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_REVOKE_DELAY_MS);
    return { uri: url, fileName, mimeType };
  },

  // The browser's download manager already has the file.
  async present() {},

  // Web's Download already saves through the browser; the menu offers no
  // "Save to device" there, so reaching this is a wiring bug.
  async pickFolder() {
    throw new Error("Saving to a picked folder is not supported on web.");
  },
};

function triggerBrowserDownload(url: string, fileName: string) {
  if (typeof document === "undefined") {
    void openExternalUrl(url);
    return;
  }

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
