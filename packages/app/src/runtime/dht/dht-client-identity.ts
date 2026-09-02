import { encodeBase64Url, decodeBase64Url, DHT_KEY_BYTES } from "@getpaseo/protocol/dht-peer";
import type * as SecureStoreTypes from "expo-secure-store";
import type * as CryptoTypes from "expo-crypto";

// `expo-secure-store` and `expo-crypto` both call `requireNativeModule(...)` at
// module scope, which THROWS when the native module is not registered — a
// version skew against expo-modules-core is enough to do it. This module sits on
// the app's boot chain (bare-dht-transport.native -> host-runtime -> _layout),
// so a static import puts two native modules between the user and a launching
// app, and turns any registration failure into a crash before an error boundary
// exists. It cost exactly that once already.
//
// The identity is optional by design — no seed means an ephemeral one — so the
// modules load on first use, inside the try below, where a failure degrades.
type SecureStoreModule = typeof SecureStoreTypes;
type CryptoModule = typeof CryptoTypes;

/**
 * This device's HyperDHT client identity, as a seed.
 *
 * Without one, every worklet start dials the daemon under a fresh public key.
 * That costs three things: the daemon cannot tell two connections from the same
 * phone apart, it has no stable subject to allowlist or revoke, and hyperdht's
 * socket pool has nothing to key a reused route against across restarts.
 *
 * The seed lives in the Keychain / Android Keystore rather than AsyncStorage,
 * because it derives a secret key. `DHT.keyPair(seed)` is deterministic, so the
 * seed is the whole identity and the secret key is never written down. Storage
 * survives app updates but not uninstall, which is the intended lifetime: an
 * identity belongs to an install, not to a build.
 */
const SEED_KEY = "paseo.dht.client.seed.v1";

let cached: Promise<string | null> | null = null;

async function readOrCreateSeed(): Promise<string | null> {
  try {
    // Dynamic on purpose: both packages call requireNativeModule() at module
    // scope and throw when the native module is not registered, so a static
    // import would move that failure onto the app's boot path. See above.
    const SecureStore: SecureStoreModule = await import("expo-secure-store");
    const { getRandomBytes }: CryptoModule = await import("expo-crypto");

    const existing = await SecureStore.getItemAsync(SEED_KEY);
    if (existing) {
      // A corrupt or truncated entry would dial under a garbage key forever, so
      // validate before trusting it and mint a fresh one if it fails.
      try {
        if (decodeBase64Url(existing).length === DHT_KEY_BYTES) return existing;
      } catch {
        // fall through and replace it
      }
    }

    const seed = encodeBase64Url(getRandomBytes(DHT_KEY_BYTES));
    await SecureStore.setItemAsync(SEED_KEY, seed, {
      // The seed is only needed while the app is running a connection, and
      // requiring anything stronger would block a background reconnect.
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    return seed;
  } catch {
    // A device with no usable secure storage still gets to connect; it just
    // dials under a fresh identity each time, which is the old behaviour.
    return null;
  }
}

/** Resolves once per process. The worker needs it before its first dial. */
export function getDhtClientSeed(): Promise<string | null> {
  cached ??= readOrCreateSeed();
  return cached;
}

/** Drops the stored identity. The next dial mints a new one. */
export async function resetDhtClientSeed(): Promise<void> {
  cached = null;
  try {
    // Dynamic for the same reason as above.
    const SecureStore: SecureStoreModule = await import("expo-secure-store");
    await SecureStore.deleteItemAsync(SEED_KEY);
  } catch {
    // Nothing stored, or no secure storage; either way there is no identity left.
  }
}
