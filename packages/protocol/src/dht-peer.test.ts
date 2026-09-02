import { describe, expect, it } from "vitest";
import {
  DHT_KEY_BYTES,
  DHT_DIAL_MAX_ATTEMPTS,
  DHT_DIAL_RETRY_BASE_MS,
  DHT_DIAL_TRANSIENT_CODES,
  PEER_FRAME_BINARY,
  PEER_FRAME_TEXT,
  PeerFrameDecoder,
  decodeBase64Url,
  decodePeerInvite,
  encodeBase64Url,
  encodePeerBinaryFrame,
  encodePeerInvite,
  encodePeerTextFrame,
} from "./dht-peer.js";

const key = (fill: number): Uint8Array => new Uint8Array(DHT_KEY_BYTES).fill(fill);

describe("dht-peer invite", () => {
  it("round-trips a public key", () => {
    const invite = encodePeerInvite({ publicKey: key(1) });
    expect(invite.startsWith("paseo-peer://v1/")).toBe(true);
    expect([...decodePeerInvite(invite).publicKey]).toEqual([...key(1)]);
  });

  it("rejects malformed invites and wrong key lengths", () => {
    expect(() => decodePeerInvite("nope")).toThrow();
    expect(() => decodePeerInvite("paseo-peer://v1/")).toThrow();
    expect(() =>
      decodePeerInvite(`paseo-peer://v1/${encodeBase64Url(new Uint8Array(8))}`),
    ).toThrow();
  });

  // The capability half is gone: HyperDHT's Noise handshake already proves both
  // ends, so an invite carrying a second secret is a stale format, not a
  // stronger one.
  it("rejects a legacy invite carrying a capability", () => {
    const legacy = `paseo-peer://v1/${encodeBase64Url(key(1))}/${encodeBase64Url(key(2))}`;
    expect(() => decodePeerInvite(legacy)).toThrow();
  });

  it("rejects non-canonical base64url", () => {
    // trailing bits set — not a canonical encoding of any byte string
    expect(() => decodeBase64Url("A")).toThrow();
  });
});

describe("dht-peer framing", () => {
  it("decodes frames split across arbitrary chunk boundaries", () => {
    const decoder = new PeerFrameDecoder();
    const full = new Uint8Array([
      ...encodePeerTextFrame("hello"),
      ...encodePeerBinaryFrame(new Uint8Array([1, 2, 3])),
    ]);
    const out: Array<{ type: number; payload: Uint8Array }> = [];
    // Feed one byte at a time to exercise the length-prefix reassembly.
    for (let i = 0; i < full.length; i += 1) out.push(...decoder.push(full.subarray(i, i + 1)));
    expect(out).toHaveLength(2);
    expect(out[0]!.type).toBe(PEER_FRAME_TEXT);
    expect(new TextDecoder().decode(out[0]!.payload)).toBe("hello");
    expect(out[1]!.type).toBe(PEER_FRAME_BINARY);
    expect([...out[1]!.payload]).toEqual([1, 2, 3]);
  });

  it("coalesces multiple frames delivered in one chunk", () => {
    const decoder = new PeerFrameDecoder();
    const frames = decoder.push(
      new Uint8Array([...encodePeerTextFrame("a"), ...encodePeerTextFrame("b")]),
    );
    expect(frames.map((f) => new TextDecoder().decode(f.payload))).toEqual(["a", "b"]);
  });

  it("reassembles a frame spanning thousands of MTU-sized chunks", () => {
    // UDX hands us ~1400-byte pieces, so a big timeline or terminal snapshot
    // arrives as thousands of chunks. Covers the multi-chunk copy path in the
    // decoder, which the small-frame cases above never reach.
    const payload = new Uint8Array(1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i & 0xff;
    const frame = encodePeerBinaryFrame(payload);

    const decoder = new PeerFrameDecoder();
    const out: Array<{ type: number; payload: Uint8Array }> = [];
    for (let offset = 0; offset < frame.length; offset += 1400) {
      out.push(...decoder.push(frame.subarray(offset, Math.min(offset + 1400, frame.length))));
    }

    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe(PEER_FRAME_BINARY);
    // Buffer.compare keeps this O(n); toEqual walks 1M elements one at a time.
    expect(Buffer.compare(Buffer.from(out[0]!.payload), Buffer.from(payload))).toBe(0);
  });
});
describe("dht dial retry policy", () => {
  it("treats holepunch and lookup failures as transient", () => {
    // The codes a dial dies with when the network, not the peer, is at fault:
    // probe exhaustion on a dozing phone, NAT race, stale announce record.
    for (const code of [
      "HOLEPUNCH_ABORTED",
      "HOLEPUNCH_PROBE_TIMEOUT",
      "HOLEPUNCH_DOUBLE_RANDOMIZED_NATS",
      "CANNOT_HOLEPUNCH",
      "REMOTE_NOT_HOLEPUNCHING",
      "REMOTE_NOT_HOLEPUNCHABLE",
      "PEER_NOT_FOUND",
      "PEER_CONNECTION_FAILED",
      "ETIMEDOUT",
      "ECONNRESET",
    ]) {
      expect(DHT_DIAL_TRANSIENT_CODES[code]).toBe(true);
    }
  });

  it("does not retry dials the peer refused or the lifecycle vetoed", () => {
    // SERVER_* means the peer answered with a refusal and SUSPENDED is a local
    // lifecycle state; redialing fixes neither.
    for (const code of ["SUSPENDED", "SERVER_ERROR", "SERVER_INCOMPATIBLE", "RELAY_ABORTED"]) {
      expect(DHT_DIAL_TRANSIENT_CODES[code] === true).toBe(false);
    }
    // Prototype keys must never read as transient: call sites guard on === true.
    expect(DHT_DIAL_TRANSIENT_CODES["constructor"] === true).toBe(false);
  });

  it("paces the ladder inside the 60s hyperdht connect budget", () => {
    // The app budgets 60s for a hyperdht connect. The worst ladder burns the
    // ~11s abort window on every attempt plus linear backoff; if the constants
    // outgrow the budget, the outer timeout kills a dial that would connect.
    const backoffMs =
      DHT_DIAL_RETRY_BASE_MS * ((DHT_DIAL_MAX_ATTEMPTS * (DHT_DIAL_MAX_ATTEMPTS - 1)) / 2);
    expect(DHT_DIAL_MAX_ATTEMPTS * 11_000 + backoffMs).toBeLessThanOrEqual(60_000);
  });
});
