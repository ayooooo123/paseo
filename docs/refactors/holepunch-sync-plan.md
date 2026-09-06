# Holepunch connection and chat sync plan

Status: transport-only implementation and local verification. The user selected a transport-first change on 2026-09-05; durable history and device replication remain separate work. The full device/network acceptance matrix has not run. Targets below are not measured results.

## Decision

Use HyperDHT for connections, Hypercore for durable timeline replication, and Hyperbee for indexed chat reads. Manage cores with Corestore and share the authenticated stream with Protomux. Add Autobase only for data that devices must edit independently, not for the daemon's execution history.

Ship transport recovery and durable daemon history first. Keep the existing client replica owners, SQLite/IndexedDB display cache, projected timeline contract, and provider adapters. Do not replace all storage or add a second chat state machine.

These changes address different failures:

| Problem                                               | Change                                                                   | Limit                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Slow or failed peer dial                              | Reuse the DHT node, bound attempts by stage, recover on network change   | No data structure can make blocked UDP or an unreachable host reachable    |
| Chat disappears while reconnecting                    | Paint the accepted local replica before network work                     | Cached history does not mean the daemon is online                          |
| Reconnect repeats history work                        | Replicate missing Hypercore blocks and resume from a verified checkpoint | A new epoch still needs a bounded replacement                              |
| Daemon restart forces provider-history reconstruction | Persist the served timeline and its projection                           | Provider execution and provider-native history remain separate authorities |
| Opening old history is slow                           | Hyperbee range indexes and complete projected checkpoints                | Sparse B-tree reads can add network round trips; measure them              |
| Attachments delay chat/control                        | Separate, resumable Hyperblobs transfers                                 | Bulk traffic still shares bandwidth                                        |
| Devices edit personal state offline                   | Autobase writer logs and a deterministic Hyperbee view                   | Unconfirmed order can change; indexer availability limits confirmation     |

No new relay service, public swarm announcement, or private-routing fork is a prerequisite. If direct UDP cannot connect, the supported choices are an already-configured alternate route or an explicit offline state. A new blind relay or replica host requires a separate deployment and privacy decision.

## Transport batch evidence

The transport lifetime and deadline rules are in [architecture](../architecture.md#peer-connection-recovery). The existing display cache and timeline ownership are unchanged.

| Exercise                                        | Result                                                                                                                                                                                                                       | Scope                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Six Node transport connections from one factory | Before: six DHT nodes and six identities. After: one node and one identity; all six text and binary echo round trips completed.                                                                                              | Local four-node DHT testnet; rebuilt client package                               |
| Four real daemon connection cycles              | Hello, `fetchAgents`, and ping completed on each cycle with one client DHT node. Dial/hello/ready traces carried the corresponding attempt ID. Closing a fifth pending dial rejected its connection promise.                 | Isolated daemon and synthetic providers; no main-daemon restart                   |
| Bare cancellation                               | The old worker reopened after a same-IPC-batch connect and close. The fixed worker did not reopen; four echo cycles and suspend/resume also completed with one identity.                                                     | Bare 1.30.3 on macOS and Node HyperDHT, real sockets                              |
| Eight concurrent CLI processes                  | All adopted one persisted seed; the final file had mode `0600` and no temporary files remained.                                                                                                                              | Separate Node processes with a temporary `PASEO_HOME`                             |
| Isolated storage spike                          | Recovered row 2001 after a forced crash between log append and index update. Sparse reads downloaded two event blocks and left block zero absent.                                                                            | Corestore 7.12.3, Hypercore 11.35.4, Hyperbee 2.22.0; not application integration |
| Binary frame boundaries                         | Before the review fix, a four-byte frame reached the consumer as 67,584 bytes. After: exact payloads survived six real DHT round trips. Node and native IPC regressions also cover pooled multi-frame buffers.               | Local DHT sockets and native-adapter IPC harness                                  |
| Probe switch completion                         | Reproduced a probe cycle resolving while its final switch was still closing the old client. The regression now waits for adoption; removed routes cannot restore a closed client or stale probe entry.                       | Host runtime regression tests                                                     |
| Deadline compatibility                          | A 60-second budget now accepts hello more than 15 seconds after open when no separate cap is set. An open after the total deadline sends no hello, even when timer delivery is delayed. Both cases failed before correction. | Fake monotonic clock and transport-event regressions                              |
| Pending network change                          | A network change during the resume await previously allowed the old connect to dial. It now sends closed, cancels that continuation, and permits a fresh connect on the retained node.                                       | Worker lifecycle regression; native bundle regenerated                            |
| Teardown failure                                | A throwing native stream destroy no longer prevents close notification, cleanup of other streams, or node destruction. Disposal reports the collected failures after cleanup.                                                | Native-boundary failure injection                                                 |

The native worker bundle was regenerated for iOS and Android targets. A host-packed Bare worker also passed real socket, reconnect, suspend/resume, and cancellation checks on macOS. No physical Android device or booted iOS simulator was available. These exercises do not prove on-device first chat paint, WAN/NAT success rate, network handoff, iOS/Android packaged runtime compatibility, battery use, or the proposed p95 targets.

## Baseline and remaining constraints

- Before this batch, `createDhtTransportFactory` created a DHT node inside each transport invocation and destroyed it when the transport closed. Mobile already retained its node and used a stable device seed and reusable sockets.
- `packages/protocol/src/dht-peer.ts:93` already defines four pre-open attempts with 400/800/1200 ms backoff. The app gives peer connects 60 seconds. Adding another retry loop or only raising that timeout is not the plan.
- `HostRuntimeController` already owned saved-route probes and online latency hysteresis. Its original active-route failover waited for every probe to settle; the transport batch changes recovery within that owner.
- `packages/server/src/server/dht/dht-transport.ts:148` adapts each accepted Noise stream to `WebSocketLike`. It logs `remotePublicKey` but does not pass a device principal at that boundary. Replication must not interpret successful Noise negotiation as permission to read every core.
- `packages/server/src/server/agent/agent-timeline-store.ts:138` keeps rows and epochs in memory. `enrichSubmittedUserMessage` also updates private provider-message mapping. This is not an append-only persistence interface yet.
- The client already paints cached chat before catch-up and already stores timelines by `agentId`: `ReplicaCache.readChatSnapshot` and `commitTimeline` in `packages/app/src/runtime/replica-cache/index.ts`. Its limits include 50 timeline items, a 5-second persistence delay, and a 32 MiB budget. Do not propose per-agent caching as a new feature.
- Native display storage is expo-sqlite; browser and Electron renderer storage is IndexedDB. Cache contents are currently not encrypted. See [data-model](../data-model.md#replica-row-store).
- The app's default/web DHT adapter throws; the native adapter owns a Bare worklet. Having a Node DHT client does not make the Electron renderer a peer client.
- `npm ls hyperdht hypercore hyperbee autobase corestore protomux --all --depth=4` reports HyperDHT 6.33.2 and transitive Protomux 3.11.0. No Hypercore, Hyperbee, Autobase, or Corestore installation appears in that report. A transitive dependency is not an application integration.

Existing correctness rules remain in [timeline-sync](../timeline-sync.md). Live coalescing and rendering rules remain in [agent-stream-performance](../agent-stream-performance.md).

## Target ownership

```text
Provider adapter
  -> daemon timeline commit owner
       -> encrypted event Hypercore (one agent and epoch)
       -> Hyperbee projected view and source checkpoint
       -> existing timeline RPCs and live presentation
       -> authorized, selective replication

Device connection owner
  -> HyperDHT Noise stream
       -> negotiated Protomux
            -> Paseo control and live messages
            -> permitted Hypercore replication
            -> bounded attachment transfer
  -> durable local replica
  -> existing viewed-timeline owner
  -> existing display cache and UI

Independent device edits, later
  -> device-owned writer cores
  -> Autobase
  -> deterministic Hyperbee user-state view
```

The connection owns the stream and mux. The host runtime owns connection recovery. Storage outlives a connection; subscriptions and download sessions do not. A reconnect creates a new stream and reattaches replication to existing cores. Hypercore does not reconnect HyperDHT for us.

### Data allocation

| Data                                                  | Owner and structure                                          | Replication policy                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Canonical served chat events                          | Daemon-only writer; one encrypted Hypercore per agent/epoch  | Focused and retained hot chats; older blocks on demand                     |
| Projected chat items and tail checkpoint              | Daemon-derived Hyperbee per matching access boundary         | Sparse ranges; bounded complete tail first                                 |
| Agent/workspace directory projection                  | Daemon-derived Hyperbee after the timeline path proves value | Preserve existing per-entity cursors and subscriptions at the app boundary |
| Provider-native message mapping                       | Daemon-private index                                         | Do not replicate private mapping merely because it shares storage          |
| Attachment bytes                                      | Hyperblobs over a separate encrypted Hypercore               | Explicit demand; thumbnails before originals                               |
| Read markers and bookmarks                            | Optional Autobase with a Hyperbee view                       | Only the user's enrolled devices                                           |
| Draft revisions                                       | Optional Autobase after conflict UX is defined               | Preserve competing edits rather than silently discard text                 |
| Prompts, stop, permissions, terminal input, schedules | Existing authorized RPC and daemon execution owner           | Never execute as an Autobase reducer side effect                           |

Do not use Hyperdrive for the whole working tree. Hyperblobs fits chat attachments without importing filesystem synchronization. Do not add Hyperswarm topic discovery for a known daemon key; consider it only if multiple approved replicas become a real requirement.

## Required security boundary

Complete this before any real chat feed is replicated, including a development rollout with real user data.

1. Bind the Noise `remotePublicKey` to an enrolled device credential and an existing daemon principal. Reuse [daemon permissions](../permissions.md); do not invent a second role system or a redundant cryptographic challenge.
2. Check current `workspace.read` authority before returning feed keys, opening a replication channel, or accepting a dynamic core request. Current grants are daemon-wide. Do not claim workspace-specific isolation until all resource-bearing paths enforce it.
3. Attach explicit allowed-core sets to each session. Corestore namespaces prevent naming collisions; they are not access controls. Do not expose the daemon's root `store.replicate()` to clients and assume unopened/private cores cannot be reached dynamically. Replicate explicit authorized cores, or prove an equivalent filter against the pinned Corestore version.
4. Reject unknown devices for replication. Revoke active replication sessions and pending downloads when a credential or grant changes. A stale reconnect cannot restore the old grant.
5. Encrypt chat/feed blocks with separate data-encryption keys. Keep device identity keys, Corestore writer secrets, and data keys separate. Provision read keys only through the authorized session. Do not put feed keys, discovery keys, or data keys in the existing peer invite, diagnostics, or public topics.
6. Encrypt the local projected chat cache as well. Block encryption does not protect plaintext copied into SQLite/IndexedDB, attachments, logs, or backups. Use platform secure storage for wrapping keys on native/desktop. For browsers, define the unlock/key-retention policy and its XSS limit before enabling a new persistent replica feature.
7. Revocation prevents future access, not reading copies already downloaded. Rotate data keys into new feed generations when future confidentiality requires it. Deletion clears local blocks/indexes and approved replicas under a retention policy; it cannot erase an untrusted offline copy. Tombstones alone are not secure erasure.

Replication is data delivery only. A valid signature proves the feed's integrity, not that its contents are safe to execute or that a device is authorized.

## Phase 0 — Establish the baseline

**Owners:** existing connection diagnostics, `DaemonClient`, `HostRuntime`, viewed-timeline synchronization, and replica-cache measurement helpers.

- Record one correlated attempt across worker startup, DHT lookup/connect, stream-open, Paseo hello, authorization, subscription, first cache paint, first authoritative paint, and caught-up state. Use local monotonic clocks; do not subtract unsynchronized device clocks.
- Record failure stage and code, retry count, route, cache hit/miss and rejection reason, bytes, queued bytes, provider hydration time, projection time, and time without sync progress. Do not record prompts or keys.
- Separate time to show cached chat from time to connect and from time to prove current history. A successful cache paint must not inflate the connection-success rate.
- Reuse `packages/app/e2e/browser/replica-cache-measurement.spec.ts`, `replica-cache-performance.spec.ts`, and the timeline resume scenarios. Add native measurements at the Bare/React Native boundary.
- Compare small, long, tool-heavy, and attachment-heavy chats on cold start, warm reconnect, daemon restart, Wi-Fi/cellular handoff, blocked UDP, and offline return. Capture the same workloads before and after each phase.

**Exit:** a reproducible report with per-platform p50/p95, failure counts and denominators, transferred bytes, peak memory, storage writes, and mobile energy observations. Root causes remain hypotheses until those measurements separate them.

## Phase 1 — Reduce connection recovery cost

**Owners:** `packages/client/src/dht-transport.ts`, `packages/app/src/runtime/dht/`, `packages/app/src/runtime/host-runtime.ts`, `packages/client/src/daemon-client.ts`.

- Give the Node client a process/host-owned DHT lifecycle and a persisted device identity. Scope reuse by identity and bootstrap configuration; a closed stream must not destroy a node still used by another session. A CLI exit must release its node.
- Preserve mobile node reuse, serialized suspend/resume, and immediate foreground retry. Verify network-change handling against the installed HyperDHT API; invalidate stale stream generations without discarding the routing table on every drop.
- Keep one pre-open retry policy and one outer reconnect owner. Cancel losing attempts and stale timers. Do not retry authorization refusals, malformed invites, or native-addon failures as transient network errors.
- Split connection setup, hello, RPC execution, and replication progress deadlines. A progressing download must not hit a request-style timeout, but an operation must still have a cancellation path and bounded resource use. Do not shorten the existing dial budget without measuring the upstream punch window.
- Refine existing route selection so a failed active route can use a ready, already-configured route without waiting for an unrelated slow probe to expire. Pin the same host identity across paths. Switch observation once and do not duplicate mutating requests.
- Show cached chat with a clear offline/reconnecting state. Keep terminal and agent liveness separate from durable history availability.

**Exit:** cold/warm dial and background/foreground scenarios pass on real iOS and Android devices. No leaked nodes, late timers that kill healthy streams, or retry storms. Blocked UDP with no alternate route reaches an explicit offline result; no claim of universal connectivity.

## Phase 2 — Prove storage and negotiated multiplexing

**Owners:** both DHT adapters, `packages/protocol/src/dht-peer.ts`, daemon DHT bridge, Bare worker build/addon plugin, and an Electron-main adapter using the existing desktop transport boundary.

- Pin a compatible Hypercore/Corestore/Hyperbee/Protomux set in an isolated spike. Inspected upstream package files report Hypercore 11.35.4, Corestore 7.12.3, and Autobase 7.28.1. These are research candidates, not an approved dependency matrix. Upstream README version prose is inconsistent; use package metadata, release tags, and runtime proof.
- Prove storage create, append, flush, close, reopen, sparse replication, interrupted transfer, and cleanup on Node and packaged Bare. Check the full native storage/addon graph, not only the existing UDP/crypto addons. Measure cold-open time, file handles, memory, disk growth, APK/IPA size, and battery cost.
- Negotiate a new mux capability through the existing Paseo hello/RPC path before changing byte framing. Define a drained, acknowledged switch boundary; do not send Protomux bytes to an old `PeerFrameDecoder` or let two readers consume the same stream.
- Reuse the framed Noise stream with Protomux/Hypercore's supported stream API. Prove that the selected integration does not accidentally create a second Noise handshake. Use separate channels for control/live data, replication, and blobs.
- Set application queue limits, write/drain handling, message-size bounds, and replication concurrency limits. Protomux separates protocols; it does not promise priority scheduling or remove shared-stream head-of-line blocking. If bulk traffic still delays control, first cap it; measure whether a separate bulk connection is necessary.
- On mobile, keep native storage and replication inside Bare. Send bounded projected batches across IPC, not every proof, token, or full history. On Electron, keep native modules and writer secrets in the main/utility process, not the renderer.
- Browser web keeps the supported WebSocket protocol and IndexedDB display cache. It benefits from daemon-side durable indexed reads. Direct browser HyperDHT and full browser Corestore replication are not assumed. A future browser bridge requires its own storage and encrypted framing proof.

**Exit:** real Node-to-Bare replication resumes after stream loss; old/new client pairs retain working chat; control remains responsive under a large transfer; unknown and revoked devices cannot obtain a core. No real-data rollout before the security boundary above passes.

## Phase 3 — Durable daemon timeline with Hypercore and Hyperbee

**Owners:** `agent-timeline-store.ts`, `timeline-append.ts`, `agent-manager.ts`, `timeline-projection.ts`, and session timeline handlers under `packages/server/src/server/`.

- Introduce one timeline commit owner behind the existing store operations. Append normalized, bounded events after the existing leading/trailing coalescer. Do not persist raw token events at a higher rate than the served timeline.
- Identify records by format version, agent, timeline epoch, source sequence, event kind, stable message identity, and turn identity where present. Keep Hypercore block index, core fork, and Paseo sequence distinct; batches and metadata make them different coordinates.
- Preserve the daemon as the only timeline writer. Use a new epoch/feed on provider-history replacement or rewind, with an explicit active-epoch pointer. Preserve an epoch across daemon restart only when the durable commit state and provider reconciliation prove continuity. Do not map arbitrary Hypercore truncation to a silent chat rewrite.
- Keep provider-native message enrichment in a private index or explicit internal event. Do not mutate a previously signed public block to match the current `enrichSubmittedUserMessage` operation.
- Build a Hyperbee materialized view with ordered projected-item keys, message lookup, source-range mapping, and a bounded complete tail checkpoint. Use sortable sequence encodings, not decimal string order. Index complete projected messages and tools, not only the last raw chunks of a long response.
- Append the source log first. Commit view updates and their `indexedThrough` source marker in one Hyperbee batch. Publish that checkpoint only after referenced source blocks are durable. A crash between log and index commits replays from the previous marker; a Hyperbee batch is not a transaction across unrelated cores.
- A live leading update may remain a provisional presentation so disk latency does not delay the first character. Durable acknowledgements and sync checkpoints must never certify it before commit. Measure and bound this provisional window.
- Persist command/submission identity and receipt state at the daemon boundary before enabling retries of ambiguous sends. On reconnect, query a receipt before resending. A crash between provider execution and receipt persistence may be indeterminate; do not promise exactly-once execution without provider support or replay such a command automatically.
- Serve the existing bounded `tail`, `before`, and `after` RPCs from the indexed view. Preserve `sourceSeqRanges`, epoch replacement, optimistic submission settlement, and scroll-anchor rules. Web and old clients gain faster server reads without importing Hypercore.
- Import old provider history lazily for the requested agent, publish only a complete initial checkpoint, and do not hydrate all agents at daemon startup. Keep provider transcripts and credentials in their existing stores. This creates durable Paseo presentation history; it does not move provider execution into Hypercore.

**Exit:** restart after each commit boundary, recover the same acknowledged rows exactly once, rebuild a lost index from the log, and handle provider edits/rewinds by explicit epoch replacement. A very long response can be opened from a bounded projected checkpoint without replaying the whole event log.

## Phase 4 — Selective device replication and fast chat open

**Owners:** `viewed-timeline-sync.ts`, `timeline-sync-plan.ts`, replica-cache owner, and the native/desktop replica adapter.

**Phase 3 to Phase 4 go/no-go gate:** first measure the durable daemon store through the existing RPCs. Proceed with device-side replication only if cold-open, history beyond the 50-item cache, or eviction recovery still misses the agreed goals, or if offline pagination is an explicit product requirement. A bounded spike must show that replication meets that need within the storage, key-management, memory, and battery budgets. If Phase 3 plus the current cache meets the goals, stop there.

Compare against the actual existing sync plan on identical cursors, cache coverage, epochs, and networks: bounded `after` pages for gap recovery, and a bounded tail only where the current planner requires replacement. Count all replication proof, index, metadata, and retransmission bytes. Hypercore may transfer more bytes than the current gap RPC; a comparison against an unnecessary full-tail reload does not justify adoption.

1. Read the existing local chat snapshot and paint it without waiting for a DHT dial, Corestore peer discovery, or `core.update()`.
2. After authorization, obtain a scoped descriptor: format/projection version, epoch, permitted core keys, committed source position, and matching projection version. Deliver data keys separately within the same protected session; redact both from diagnostics.
3. Open only the focused and existing hot-set feeds. Fetch the complete tail checkpoint and the blocks it needs before background ranges. Do not start `download({ start: 0, end: -1 })` for every chat.
4. Resume from verified coverage. A signed feed length is not proof that all local blocks or a projected range are present. Persist displayed items and the exact accepted coverage in the same local transaction.
5. Cancel obsolete range requests when focus, epoch, host, or connection generation changes. Use non-waiting local reads and bounded/cancellable network reads; Hypercore's default indefinite wait must not become a new chat spinner.
6. Preserve current live-gap recovery and bounded reconnect-tail rules at the existing timeline owner. An accepted unchanged checkpoint is a display no-op. Old history remains user-driven. Use one canonical ingestion path so live RPC data and replicated data cannot create duplicate rows.
7. Treat the SQL/IndexedDB row as a disposable display materialization, not a second source authority. Retain it until measurements prove that replacing it improves first paint. Flush accepted state at safe lifecycle boundaries without writing on every token or delaying paint.
8. Enforce byte-based cache budgets and eviction outside the paint path. Keep focused/hot projected data and required index blocks; clear cold downloaded ranges deliberately. If a required range is removed, remove its coverage claim too. Benchmark longer-history retention against the current 50-item tail rather than merely raising its limit.

**Exit:** cached chats paint offline; a reconnect transfers missing requested blocks rather than the whole transcript; switching chats does not start full-history hydration; eviction and missing blocks cannot produce a false current state.

## Phase 5 — Resumable attachments; optional read replicas

**Owners:** existing attachment store/upload paths plus the authorized replication service.

- Store large attachment payloads in Hyperblobs. Timeline records contain bounded metadata and a validated blob reference with its core generation, bounds, size, media type, and content hash where needed. Hyperblobs references are block/byte bounds, not automatic content-addressed deduplication.
- Preserve existing tool-output caps. Do not make each chat open fetch full shell output or original images.
- Resume requested ranges after reconnect; verify referenced bounds, cap reads, cancel abandoned transfers, and keep byte buffers out of repeated JSON/IPC copies.
- New device-origin attachments enter an authorized upload/staging path. A replicated blob is not permission to send a prompt; the daemon validates it before recording the accepted message.
- If history availability while the laptop is off is needed, separately approve a trusted always-on replica. It can serve encrypted history blocks but cannot execute agents. Require retention, revocation/key-rotation, freshness, and cost policies. Display the last verified checkpoint, not a false claim that the sleeping daemon is current.

**Exit:** a large transfer resumes without restarting from byte zero, and does not breach control latency/memory budgets. No replica infrastructure is deployed as part of the default plan.

## Phase 6 — Autobase for real offline multiwriter state

**First scope:** read markers and bookmarks. Draft revisions come next only after conflict behavior is specified. Existing daemon-global labels stay host-local; do not silently turn them into a cross-host catalog.

- Give each enrolled device its own writer core. Use one encrypted Autobase per user-owned collection and a Hyperbee view. Separate write permission for that collection from daemon execution authority.
- Start with the daemon as the single indexer and devices as non-indexer writers. Offline edits can be shown as pending locally; confirmed order advances when the indexer is available. Only adopt a larger trusted indexer set if confirmation during daemon outages is required. Phones that sleep must not form an assumed always-online quorum.
- Make `apply` deterministic and limited to its provided view and writer-membership operations. No wall-clock conflict decisions, network calls, provider commands, terminal writes, or notifications inside `apply`.
- Include stable operation identity, object identity, causal/revision references, and delete tombstones. Merge read markers by position only within the same epoch. Keep concurrent draft revisions available for resolution. Define delete-versus-edit and membership-revocation semantics before enabling writes.
- Distinguish pending view state from confirmed checkpoints using Autobase's documented signed/indexed state. New information can undo and reapply the pending view. Do not equate local append success with globally final order.
- Handle view/schema upgrades explicitly. Unsupported operations stop that collection with an update requirement rather than silently lose data. Quota and rate-limit writer inputs.

**Exit:** two disconnected devices edit the same objects, reconnect in both orders, and converge without lost draft text or resurrected deletes. Repeat with a sleeping indexer, revoked writer, replayed operation, and unsupported view version. No external action runs during reordering.

## Rollout and rollback

Follow [protocol compatibility](../protocol-compatibility.md): optional capability fields, dotted new RPC names, pure wire schemas, and one capability decision in the owner. Proposed capabilities should distinguish durable history, mux replication, blobs, and collaborative user state rather than one flag that implies all of them.

Ship each phase independently. First compare the new daemon projection in a bounded shadow mode against the existing served view; it must not dispatch duplicate events or become a second execution path. Cut over one timeline owner only after parity passes, then remove the shadow path. Existing wire schemas remain accepted for version drift, with dated compatibility tags where needed.

Rollback means selecting the prior release/path deliberately, not hidden per-request fallback. Retain old provider data and the new durable logs until the rollback window ends. Because Paseo-only events may not exist in provider transcripts, export/checkpoint those events before rolling back to a daemon that cannot read the new store. A core format or key change must never reset data silently.

Update the owning architecture, timeline, data-model, permissions/security, native-build, and protocol documents as the respective behavior lands. This plan is not evidence that those features exist.

## Acceptance targets and proof

Initial targets below must be checked against Phase 0 and the agreed device/network matrix. Do not report them as achieved or hide failed attempts by extending the timeout.

| Measure                                                | Proposed gate                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cached first meaningful chat paint, after route demand | p95 at most 250 ms on each selected reference device, with network disabled                                                                                                     |
| Warm peer reconnect on reachable reference networks    | p95 at most 2 seconds to authenticated Paseo readiness; report all failures separately                                                                                          |
| Cached chat reaches a known current checkpoint         | p95 at most 1 second after stream readiness for a bounded small gap on the reference WAN profile                                                                                |
| Cold uncached chat open after stream readiness         | No more than 10% p95 regression versus the existing bounded-tail path                                                                                                           |
| Warm-reconnect history transfer                        | No more total wire bytes than the existing bounded `after` RPC path for the same small cursor gap; include proof/index overhead. Compare required tail replacements separately. |
| User-visible connection/timeouts                       | At least 50% fewer than baseline on the same affected workload; report numerator, denominator, and observation window                                                           |
| Bulk transfer impact                                   | Control-response p95 no more than 10% above the same-link no-transfer baseline                                                                                                  |
| Correctness                                            | Zero lost acknowledged rows, duplicate submissions, false coverage claims, or unauthorized replication in fault scenarios                                                       |
| Resources                                              | Bounded queues and storage; agree per-device RSS, disk-write, package-size, and energy budgets from Phase 0 before enabling replication                                         |

Use LAN, representative high-RTT/lossy WAN, Wi-Fi/cellular handoff, symmetric/double-random NAT, blocked UDP, background suspension, daemon crash, disk-full, corrupt local replica, missing index blocks, epoch reset, and credential revocation. Report direct and configured alternate routes separately. Do not mix native, browser, Electron, and CLI results.

Run specific affected tests, not the full local suite. Keep regressions for crash boundaries, stale-generation races, coverage integrity, revocation, and Autobase conflicts. Prove transport/storage interoperability with real Node/Bare processes, and prove chat latency with actual rendered surfaces and on-device runs. Run typecheck/lint once after each completed implementation batch; rebuild owning workspace declarations before diagnosing cross-package failures.

## First implementation batch

Start with Phase 0 and Phase 1, then the Node storage portion of the Phase 2 spike and Phase 3 durable daemon reads. Native storage, mux cutover, and device replication are conditional on the Phase 4 go/no-go gate. Complete their interoperability and authorization/key gates before real chat replication. The main data milestone is durable Hypercore history plus Hyperbee projected reads; Autobase is not on that milestone's critical path.

## Upstream references

- [HyperDHT](https://docs.pears.com/reference/building-blocks/hyperdht/): keyed connections, Noise, firewall, and lifecycle.
- [Hypercore](https://github.com/holepunchto/hypercore): sparse reads, replication, signed forks, encryption, and cancellable download ranges.
- [Corestore](https://github.com/holepunchto/corestore): storage ownership, sessions, key derivation, and all-to-all replication behavior.
- [Hyperbee](https://github.com/holepunchto/hyperbee): sorted sparse reads, snapshots, diffs, and atomic batches.
- [Protomux](https://github.com/holepunchto/protomux): framed-stream protocol channels; no documented priority scheduler.
- [Hyperblobs](https://github.com/holepunchto/hyperblobs): chunked blobs addressed by core bounds.
- [Autobase](https://github.com/holepunchto/autobase): deterministic views, reorderable pending history, writer/indexer membership, and signed checkpoints.
