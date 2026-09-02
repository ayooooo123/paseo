// Default / web resolution for the HyperDHT transport. The real implementation
// lives in `bare-dht-transport.native.ts` and loads `react-native-bare-kit`
// (native-only). Metro resolves the `.native.ts` variant on iOS/Android; web and
// Node test bundles get this stub so the native package is never loaded off-device.
// P2P over HyperDHT is not available on web.
import type { DaemonTransportFactory } from "@getpaseo/client/internal/daemon-client-transport-types";

export interface BareDhtTransportOptions {
  invite: string;
  bootstrap?: string[];
  workerBundle: string;
}

export function createBareDhtTransportFactory(
  _options: BareDhtTransportOptions,
): DaemonTransportFactory {
  return () => {
    throw new Error("HyperDHT peer transport is only available on native (iOS/Android)");
  };
}
