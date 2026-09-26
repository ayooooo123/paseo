import { downloadPlatform } from "@/stores/download-platform";
import { createDownloadStore } from "@/stores/download-store";

export const useDownloadStore = createDownloadStore(downloadPlatform);
