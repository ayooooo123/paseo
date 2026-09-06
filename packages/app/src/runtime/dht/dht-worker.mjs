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
let connectionId = null;
let retryTimer = null;
let dhtDecoder = null;
let phase = "idle"; // idle -> connecting -> open

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
  const ownerId = connectionId;
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
      connectionId: ownerId,
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
  ipc.write(
    encodePeerFrame(PEER_FRAME_CONTROL, te.encode(JSON.stringify({ connectionId, ...message }))),
  );
}

/** Cancel a scheduled dial retry, if one is pending. */
function clearRetry() {
  if (retryTimer === null) return;
  clearTimeout(retryTimer);
  retryTimer = null;
}

/**
 * Invalidate the current dial intent. A connect() that is still waiting out an
 * await must lose, and a scheduled retry must not fire: bumping connectSession
 * makes every stale guard fail, and clearing retryTimer stops the timer
 * outright. Every control that has to guarantee "no dial survives me" — close,
 * suspend, shutdown, and a hyperdht network-change — calls this first. A later
 * connect() claims a fresh session and dials again.
 */
function invalidateDial() {
  clearRetry();
  connectSession++;
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

/**
 * hyperdht 6.33.2 emits 'network-change' from dht-rpc's interface watcher when
 * the OS swaps networks under the node. Upstream does not recover a client
 * dial from it: hyperdht refreshes only its *listening* servers
 * (hyperdht/index.js), and dht-rpc just re-emits. The sockets a dial or an
 * open stream was using are on the dead interface, so cancel the live dial,
 * tell RN "closed" (RN redials over the same warm node), and keep the node —
 * its routing table and peer cache are what make that redial cheap, and
 * dht-rpc refreshes the table in the background. Destroying the node here
 * would repay the bootstrap on every network flip.
 */
function onNetworkChange(node) {
  return () => {
    // A change event from a node this worker already replaced or destroyed.
    if (dht !== node) return;
    // Cancel pending continuations as well as sockets bound to the old network.
    if (phase === "idle" && stream === null && retryTimer === null) return;
    invalidateDial();
    closeStream();
    ipcControl({ ipc: "closed" });
  };
}

/**
 * Replace the node because the bootstrap set changed, keeping the caller's
 * dial session alive. teardown() must not be used here: it invalidates the
 * session, and this connect is still the current one.
 */
function rebuildNode() {
  closeStream();
  const node = dht;
  dht = null;
  dhtBootstrapKey = null;
  // destroy() is async — an unhandled rejection here would take down the worklet.
  node?.destroy().catch(() => {});
}

/** Tear everything down, including the node. Only on worklet shutdown. */
function teardown() {
  // Invalidate before destroying: a connect() still inside its awaits must not
  // rebuild a node after shutdown and dial, and a pending retry must not fire
  // on whatever replaces it.
  invalidateDial();
  closeStream();
  const node = dht;
  dht = null;
  dhtBootstrapKey = null;
  // destroy() is async — an unhandled rejection here would take down the worklet.
  node?.destroy().catch(() => {});
}

async function connect(invite, bootstrap, seed, ownerId) {
  const session = ++connectSession;
  connectionId = ownerId;
  clearRetry();
  closeStream();
  phase = "connecting";
  try {
    await loadNativeModules();
    if (session !== connectSession) return;
    const target = decodePeerInvite(invite).publicKey;
    const bootstrapKey = bootstrap && bootstrap.length ? bootstrap.join(",") : "";
    if (dht && dhtBootstrapKey !== bootstrapKey) rebuildNode();
    if (!dht) {
      const node = new DHT({
        ...(bootstrapKey ? { bootstrap } : {}),
        // Paseo's heartbeat detects liveness; this foreground keepalive keeps
        // the NAT mapping without the default five-second radio wakeup.
        connectionKeepAlive: 25_000,
      });
      node.on("network-change", onNetworkChange(node));
      dht = node;
      dhtBootstrapKey = bootstrapKey;
    }

    // suspend/resume are serialized. A close during this await must also
    // report the pending dial as closed so foreground recovery can redial.
    phase = "connecting";
    await requestLifecycle("resumed");
    if (session !== connectSession) return;
    const keyPair = seed ? DHT.keyPair(decodeBase64Url(seed)) : undefined;
    attemptDial({ session, connectionId: ownerId, node: dht, target, keyPair }, 1);
  } catch (error) {
    if (session !== connectSession) return;
    ipcControl({
      ipc: "error",
      connectionId: ownerId,
      message: String(error?.message ?? error),
      code: error?.code ?? null,
    });
  }
}

// One hyperdht connect() is exactly one attempt: a transient failure destroys
// the socket and upstream retries nothing (lib/connect.js). The failure this
// ladder exists for is probe exhaustion on a dozing phone: a locked device can
// eat one ~10s consistent-probe window (holepuncher.js:222-237) and then punch
// cleanly on the very next dial. Pre-open only — once open, an error is a
// dropped connection, not a dial failure — and the node stays warm, because a
// fresh node would repay the DHT bootstrap on every attempt.
function attemptDial(ctx, attempt) {
  // A superseded connect bails before spending a dial; the node check stops a
  // scheduled retry from dialing on a node that was rebuilt or destroyed since.
  if (ctx.session !== connectSession || ctx.node !== dht) return;
  const id = ++streamId;
  const live = () => streamId === id && dht === ctx.node && connectSession === ctx.session;
  stream = ctx.node.connect(ctx.target, {
    reusableSocket: true,
    ...(ctx.keyPair ? { keyPair: ctx.keyPair } : {}),
  });
  dhtDecoder = new PeerFrameDecoder();
  phase = "connecting";

  stream.on("open", () => {
    if (!live()) return;
    // HyperDHT authenticated the dial, so the stream is usable immediately.
    phase = "open";
    ipcControl({ ipc: "open", connectionId: ctx.connectionId });
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
      clearRetry();
      const timer = setTimeout(() => {
        // Only this timer clears itself: a newer ladder may have replaced
        // retryTimer while this one was pending, and must stay cancellable.
        if (retryTimer === timer) retryTimer = null;
        // close/suspend/shutdown superseded the dial, or the node it dialed on
        // is gone; the ladder ends quietly and a fresh connect starts over.
        if (ctx.session !== connectSession || ctx.node !== dht || desiredState !== "resumed")
          return;
        attemptDial(ctx, attempt + 1);
      }, DHT_DIAL_RETRY_BASE_MS * attempt);
      retryTimer = timer;
      return;
    }
    ipcControl({
      ipc: "error",
      connectionId: ctx.connectionId,
      message: String(error?.message ?? error),
      code,
    });
  });
  stream.on("end", () => {
    if (live()) ipcControl({ ipc: "closed", connectionId: ctx.connectionId });
  });
  stream.on("close", () => {
    if (live()) ipcControl({ ipc: "closed", connectionId: ctx.connectionId });
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
        // connect catches native-addon failures without taking down the worklet.
        void connect(message.invite, message.bootstrap, message.seed, message.connectionId);
      } else if (message.ipc === "close") {
        // RN released the sink: no dial may outlive it. Invalidate so an
        // in-flight connect bails at its next guard and a scheduled retry is
        // cancelled — neither may dial after RN moved on.
        invalidateDial();
        closeStream();
      } else if (message.ipc === "shutdown") {
        teardown();
      }
      // Backgrounding. Note what suspend does NOT do: hyperdht's suspend()
      // calls rawStreams.clear() (index.js:113-118), which destroys every
      // stream in the set (lib/raw-stream-set.js:26-34). The open stream does
      // not survive and resume() does not bring it back — the client has to
      // redial. Suspending is still right, because the OS freezes the process
      // anyway and a parked node resumes without re-bootstrapping.
      else if (message.ipc === "suspend") {
        // closeStream() invalidates the stream handlers before destroy(), so
        // their close event is intentionally ignored. Tell RN explicitly — for
        // an open stream and for a retry sitting in backoff — so it enters
        // disconnected state now and foreground retryAllNow() can redial
        // immediately instead of waiting for heartbeat expiry.
        const hadDial = phase !== "idle" || stream !== null || retryTimer !== null;
        invalidateDial();
        closeStream();
        if (hadDial) ipcControl({ ipc: "closed" });
        void requestLifecycle("suspended");
      } else if (message.ipc === "resume") {
        void requestLifecycle("resumed");
      }
      continue;
    }
    // Application frame from RN -> forward to the daemon over the DHT stream.
    if (phase !== "open" || !stream) continue;
    if (type !== PEER_FRAME_TEXT && type !== PEER_FRAME_BINARY) continue;
    stream.write(encodePeerFrame(type, payload));
  }
});
