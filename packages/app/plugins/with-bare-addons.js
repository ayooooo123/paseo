const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { withDangerousMod } = require("expo/config-plugins");

// Bare worker addons (udx-native, sodium-native, and the bare-* runtime addons
// hyperdht pulls in) are native code. `bare-pack --linked` in
// scripts/build-dht-worker.mjs emits references to them rather than embedding
// them, so the app must ship the matching binary per ABI. `bare-link` reads each
// addon package's `prebuilds/<host>/` and produces the layout Bare resolves at
// runtime: `lib<name>.<version>.so` on Android, an xcframework on Apple.
//
// Without this step the worklet throws ADDON_NOT_FOUND at `import hyperdht`,
// and an uncaught throw on the worklet thread aborts the whole app process.
//
// react-native-bare-kit already ships this step — a Gradle `link` task and the
// BareKit podspec's `prepare_command` both run its own `link.mjs`. Both link
// from `node_modules/react-native-bare-kit/{android,ios}/../../..`, the repo
// root, and this root package.json declares no dependencies because the app
// lives in `packages/app`. So upstream's linking walks an empty graph, writes
// nothing, and fails silently. Linking from the app package is what finds
// hyperdht's addons.
//
// This runs on every prebuild because `expo prebuild --clean` regenerates the
// native projects, which would otherwise drop the linked binaries.
const ANDROID_HOSTS = ["android-arm64", "android-arm", "android-ia32", "android-x64"];
const APPLE_HOSTS = ["ios-arm64", "ios-arm64-simulator", "ios-x64-simulator"];

function runBareLink(appRoot, hosts, outDir) {
  // Resolve the installed CLI rather than shelling out to `npx bare-link`: on a
  // cold EAS builder `npx` will happily fetch a different version from the
  // registry, which is how you ship addons that mismatch the bundle.
  // `bare-link` only exports `.`, so derive the bin from the package root.
  const bareLinkBin = path.join(path.dirname(require.resolve("bare-link")), "bin.js");

  const result = spawnSync(
    process.execPath,
    [bareLinkBin, ...hosts.flatMap((host) => ["--host", host]), "--out", outDir],
    { cwd: appRoot, stdio: "inherit" },
  );

  if (result.status !== 0) {
    throw new Error(
      `bare-link failed (exit ${result.status ?? "signal"}); the Bare worker's native addons would be missing`,
    );
  }
}

function withBareAddons(config) {
  const withAndroid = withDangerousMod(config, [
    "android",
    (modConfig) => {
      runBareLink(
        modConfig.modRequest.projectRoot,
        ANDROID_HOSTS,
        path.join(modConfig.modRequest.platformProjectRoot, "app", "src", "main", "jniLibs"),
      );
      return modConfig;
    },
  ]);

  return withDangerousMod(withAndroid, [
    "ios",
    (modConfig) => {
      // The BareKit podspec vendors `addons/*.xcframework` from its own package
      // directory, so writing there needs no Xcode project surgery and no second
      // pod. Prebuild's `pod install` runs after this mod, and upstream's
      // `prepare_command` finds nothing to add, leaving these frameworks in place.
      const bareKitIos = path.join(
        path.dirname(require.resolve("react-native-bare-kit/package.json")),
        "ios",
      );
      runBareLink(modConfig.modRequest.projectRoot, APPLE_HOSTS, path.join(bareKitIos, "addons"));
      return modConfig;
    },
  ]);
}

module.exports = withBareAddons;
