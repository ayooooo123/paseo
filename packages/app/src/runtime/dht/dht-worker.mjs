// Bare worklet: runs HyperDHT on-device and bridges the authenticated DHT stream
// to React Native over BareKit's IPC duplex.
//
// This file is NOT bundled by Metro; it is packed by `bare-pack` (see
// scripts/build-dht-worker.mjs) into a self-contained bundle that
// `react-native-bare-kit` loads. It runs under the Bare runtime and never
// imports `node:*`.
//
// IPC wire (RN <-> worker) reuses the same length-prefixed frame envelope as the
// DHT wire: CONTROL frames carry small JSON {ipc: "..."} messages; TEXT/BINARY
// frames carry Paseo application bytes verbatim.
// eslint-disable-next-line import/no-unassigned-import -- polyfill, evaluated for effect
import "./bare-text-polyfill.mjs";
import {
  PeerFrameDecoder,
  PEER_FRAME_CONTROL,
  PEER_FRAME_TEXT,
  PEER_FRAME_BINARY,
  decodeBase64Url,
  decodePeerInvite,
  encodePeerFrame,
  DHT_DIAL_MAX_ATTEMPTS,
  DHT_DIAL_RETRY_BASE_MS,
  DHT_DIAL_TRANSIENT_CODES,
} from "@getpaseo/protocol/dht-peer";
// `hyperdht` loads native addons. Those addons are linked into the app by
// `bare-link` (plugins/with-bare-addons.js), not embedded in this bundle.
// Importing it statically means a missing or ABI-mismatched addon throws during
// module evaluation, and an uncaught throw on the worklet thread aborts the
// entire host process — the user loses the whole app, not just P2P. Loading it
// on demand keeps that failure reportable over IPC.
let DHT = null;

async function loadNativeModules() {
  if (DHT) return;
  DHT = (await import("hyperdht")).default;
}

const ipc = BareKit.IPC;
const te = new TextEncoder();
const td = new TextDecoder();

const ipcDecoder = new PeerFrameDecoder();
let dht = null;
let dhtBootstrapKey = null;
let stream = null;
let streamId = 0;
let connectSession = 0;
let dhtDecoder = null;
let phase = "idle"; // idle -> connecting -> open
let publicKey = null;

// hyperdht's suspend() and resume() are async several layers deep and have no
// internal lock: suspend() sets `_connectable = false` on its first line, then
// awaits server suspends and two rawStreams.clear() passes. Calling them
// concurrently — which a quick background/foreground does — interleaves those
// stages and can leave the node parked with nothing pending to unpark it. So
// transitions run one at a time, and only the latest requested state matters:
// flicking background→foreground→background collapses to one suspend.
let lifecycle = Promise.resolve();
let desiredState = "resumed";

async function applyLifecycle(next) {
  // A newer request superseded this one while it waited its turn.
  if (desiredState !== next) return;
  const node = dht;
  // No node yet: nothing to park, but RN is waiting on the ack before it
  // freezes the worklet, so answer anyway.
  if (!node) {
    ipcControl({ ipc: next });
    return;
  }
  try {
    if (next === "suspended") await node.suspend();
    else await node.resume();
  } catch (error) {
    ipcControl({
      ipc: "error",
      message: String(error?.message ?? error),
      code: error?.code ?? null,
    });
    return;
  }
  if (desiredState === next) ipcControl({ ipc: next });
}

function requestLifecycle(next) {
  desiredState = next;
  const previous = lifecycle;
  // A failed transition must not poison the queue for the next one.
  lifecycle = (async () => {
    await previous.catch(() => {});
    await applyLifecycle(next);
  })();
  return lifecycle;
}

function ipcControl(message) {
  ipc.write(encodePeerFrame(PEER_FRAME_CONTROL, te.encode(JSON.stringify(message))));
}

/** Drop the current stream but keep the DHT node warm for the next dial. */
function closeStream() {
  const hadStream = stream !== null || phase !== "idle";
  streamId++;
  const current = stream;
  stream = null;
  phase = "idle";
  try {
    current?.destroy();
  } catch {}
  return hadStream;
}

/** Tear everything down, including the node. Only on worklet shutdown. */
function teardown() {
  // No connectSession bump: connect() calls this on bootstrap change before
  // dialing with its already-claimed session, and a pending retry timer is
  // already stopped by the !dht check below (teardown nulls the node).
  closeStream();
  const node = dht;
  dht = null;
  dhtBootstrapKey = null;
  // destroy() is async — an unhandled rejection here would take down the worklet.
  node?.destroy().catch(() => {});
}

async function connect(invite, bootstrap, seed) {
  // Claim the session before the first await: a stale connect that finishes
  // its awaits after a newer one must lose, so order is taken at call time.
  const session = ++connectSession;
  await loadNativeModules();

  publicKey = decodePeerInvite(invite).publicKey;

  // Reuse the node across reconnects: a fresh DHT throws away the routing table
  // and the cached peer address, so every reconnect would re-bootstrap and dial
  // cold. Only rebuild it when the bootstrap set actually changes.
  const bootstrapKey = bootstrap && bootstrap.length ? bootstrap.join(",") : "";
  if (dht && dhtBootstrapKey !== bootstrapKey) teardown();
  if (!dht) {
    dht = new DHT({
      ...(bootstrapKey ? { bootstrap } : {}),
      // hyperdht defaults this to 5000, which writes an empty frame on every
      // open socket every 5s. Paseo already runs its own 10s liveness ping
      // (DaemonClient LIVENESS_HEARTBEAT_INTERVAL_MS), so the socket-level
      // keepalive only has to outlive the NAT mapping, not detect death.
      // Cellular UDP mappings run minutes, so 25s is well inside the envelope
      // and wakes the radio a fifth as often. Foreground only — a backgrounded
      // app is frozen and sends nothing regardless.
      connectionKeepAlive: 25_000,
    });
    dhtBootstrapKey = bootstrapKey;
  } else {
    closeStream();
  }

  // A dial made while the node is parked is destroyed on the spot with a
  // SUSPENDED error (hyperdht/lib/connect.js:61-65), and suspend() sets
  // `_connectable = false` on its first line. So wait out whatever transition
  // is in flight and put the node in the resumed state before asking for a
  // stream. This is the whole background→foreground→dial path.
  await requestLifecycle("resumed");

  // A stable client keypair, derived from the seed RN keeps in secure storage.
  // Without it hyperdht mints a throwaway key per dial and the daemon sees a
  // different peer every reconnect. reusableSocket keeps the punched UDP route
  // in the socket pool for 3s after close (lib/socket-pool.js LINGER_TIME), so
  // a quick leave-and-return redials without punching again.
  const keyPair = seed ? DHT.keyPair(decodeBase64Url(seed)) : undefined;
  attemptDial(session, keyPair, 1);
}

// One hyperdht connect() is exactly one attempt: a transient failure destroys
// the socket and upstream retries nothing (lib/connect.js). The failure this
// ladder exists for is probe exhaustion on a dozing phone: a locked device can
// eat one ~10s consistent-probe window (holepuncher.js:222-237) and then punch
// cleanly on the very next dial. Pre-open only — once open, an error is a
// dropped connection, not a dial failure — and the node stays warm, because a
// fresh node would repay the DHT bootstrap on every attempt.
function attemptDial(session, keyPair, attempt) {
  // A superseded connect bails before spending a dial.
  if (session !== connectSession) return;
  const id = ++streamId;
  const live = () => streamId === id && session === connectSession;
  stream = dht.connect(publicKey, {
    reusableSocket: true,
    ...(keyPair ? { keyPair } : {}),
  });
  dhtDecoder = new PeerFrameDecoder();
  phase = "connecting";

  stream.on("open", () => {
    if (!live()) return;
    // HyperDHT authenticated the dial, so the stream is usable immediately.
    phase = "open";
    ipcControl({ ipc: "open" });
  });
  stream.on("error", (error) => {
    const code = error?.code ?? null;
    if (!live()) return;
    if (
      phase === "connecting" &&
      attempt < DHT_DIAL_MAX_ATTEMPTS &&
      DHT_DIAL_TRANSIENT_CODES[code] === true
    ) {
      // Abandon the attempt without telling RN: invalidate its handlers first,
      // so the destroyed socket's close event can't surface a spurious "closed"
      // for a dial that is about to be retried.
      streamId++;
      const failed = stream;
      stream = null;
      try {
        failed?.destroy();
      } catch {}
      setTimeout(() => {
        // A suspend or teardown during the backoff ends the ladder quietly;
        // the foreground redial path starts a fresh connect.
        if (session !== connectSession || !dht || desiredState !== "resumed") return;
        attemptDial(session, keyPair, attempt + 1);
      }, DHT_DIAL_RETRY_BASE_MS * attempt);
      return;
    }
    ipcControl({
      ipc: "error",
      message: String(error?.message ?? error),
      code,
    });
  });
  stream.on("end", () => {
    if (live()) ipcControl({ ipc: "closed" });
  });
  stream.on("close", () => {
    if (live()) ipcControl({ ipc: "closed" });
  });
  stream.on("data", (chunk) => {
    if (!live()) return;
    let frames;
    try {
      frames = dhtDecoder.push(chunk);
    } catch {
      stream.destroy();
      return;
    }
    for (const { type, payload } of frames) {
      // Forward verbatim: decoding and re-encoding UTF-8 here would burn CPU
      // on every terminal frame for no reason — RN decodes once on receipt.
      if (type === PEER_FRAME_TEXT || type === PEER_FRAME_BINARY) {
        ipc.write(encodePeerFrame(type, payload));
      }
    }
  });
}

ipc.on("data", (chunk) => {
  let frames;
  try {
    frames = ipcDecoder.push(chunk);
  } catch {
    return;
  }
  for (const { type, payload } of frames) {
    if (type === PEER_FRAME_CONTROL) {
      const message = JSON.parse(td.decode(payload));
      if (message.ipc === "connect") {
        // An unhandled rejection here aborts the worklet thread and with it the
        // whole app, so every dial failure — including a missing native addon —
        // has to come back as an IPC error the RN side can surface.
        connect(message.invite, message.bootstrap, message.seed).catch((error) => {
          ipcControl({
            ipc: "error",
            message: String(error?.message ?? error),
            code: error?.code ?? null,
          });
        });
      } else if (message.ipc === "close") closeStream();
      else if (message.ipc === "shutdown") teardown();
      // Backgrounding. Note what suspend does NOT do: hyperdht's suspend()
      // calls rawStreams.clear() (index.js:113-118), which destroys every
      // stream in the set (lib/raw-stream-set.js:26-34). The open stream does
      // not survive and resume() does not bring it back — the client has to
      // redial. Suspending is still right, because the OS freezes the process
      // anyway and a parked node resumes without re-bootstrapping.
      else if (message.ipc === "suspend") {
        // closeStream() invalidates the stream handlers before destroy(), so
        // their close event is intentionally ignored. Tell RN explicitly: it
        // must enter disconnected state now so foreground retryAllNow() can
        // redial immediately instead of waiting for heartbeat expiry.
        if (closeStream()) ipcControl({ ipc: "closed" });
        void requestLifecycle("suspended");
      } else if (message.ipc === "resume") void requestLifecycle("resumed");
      continue;
    }
    // Application frame from RN -> forward to the daemon over the DHT stream.
    if (phase !== "open" || !stream) continue;
    if (type !== PEER_FRAME_TEXT && type !== PEER_FRAME_BINARY) continue;
    stream.write(encodePeerFrame(type, payload));
  }
});
