/**
 * HyperDHT peer transport — shared, runtime-portable wire definitions.
 *
 * This module is imported by the daemon (Node), the CLI (Node), and the mobile
 * app (React Native / Bare worker), so it MUST stay free of `node:*` imports and
 * of `Buffer`.
 *
 * Invite: `paseo-peer://v1/<base64url pubkey>`
 *
 * There is no application handshake. HyperDHT dials are Noise sessions keyed by
 * the daemon's public key, so by the time a stream opens both ends are already
 * authenticated: the dialer has proven the daemon holds the secret half of the
 * key it dialed, and the daemon has the dialer's public key on the stream. An
 * additional challenge/proof exchange re-authenticated what the transport had
 * already established. Application frames (text/binary) carrying the ordinary
 * Paseo WebSocket protocol start immediately.
 */

export const DHT_INVITE_PREFIX = "paseo-peer://v1/";
export const DHT_KEY_BYTES = 32;
/** Matches the daemon's 8 MiB outbound high-water mark. */
export const DHT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

// ---- base64url (portable, no atob/Buffer) ----------------------------------
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : undefined;
    out += B64URL[a >>> 2]!;
    out += B64URL[((a & 0x03) << 4) | ((b ?? 0) >>> 4)]!;
    if (b !== undefined) out += B64URL[((b & 0x0f) << 2) | ((c ?? 0) >>> 6)]!;
    if (c !== undefined) out += B64URL[c & 0x3f]!;
  }
  return out;
}

export function decodeBase64Url(value: string): Uint8Array {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid base64url");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of value) {
    const idx = B64URL.indexOf(ch);
    if (idx < 0) throw new Error("invalid base64url");
    acc = (acc << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0)
    throw new Error("invalid base64url trailing bits");
  const bytes = new Uint8Array(out);
  if (encodeBase64Url(bytes) !== value) throw new Error("non-canonical base64url");
  return bytes;
}

// ---- invite ----------------------------------------------------------------
// The invite is the daemon's HyperDHT public key and nothing else. HyperDHT
// dials are Noise sessions keyed by that public key: only the daemon holding the
// matching secret key can complete one, and the daemon sees the dialer's own
// public key on the accepted stream. Knowing the key is therefore both the
// address and the capability, which is why there is no second secret here.
export interface PeerInvite {
  readonly publicKey: Uint8Array;
}

export function encodePeerInvite(invite: PeerInvite): string {
  if (invite.publicKey.length !== DHT_KEY_BYTES) throw new Error("invalid public key length");
  return `${DHT_INVITE_PREFIX}${encodeBase64Url(invite.publicKey)}`;
}

export function decodePeerInvite(value: string): PeerInvite {
  if (typeof value !== "string" || !value.startsWith(DHT_INVITE_PREFIX))
    throw new Error("invalid peer invite");
  const encoded = value.slice(DHT_INVITE_PREFIX.length);
  if (!encoded || encoded.includes("/")) throw new Error("invalid peer invite");
  const publicKey = decodeBase64Url(encoded);
  if (publicKey.length !== DHT_KEY_BYTES) throw new Error("invalid peer invite key length");
  return { publicKey };
}

/** Safe metadata: the routing public-key fingerprint. */
export function peerInviteFingerprint(invite: PeerInvite): string {
  return encodeBase64Url(invite.publicKey).slice(0, 12);
}

// ---- dial retry policy ------------------------------------------------------
// Raw hyperdht never retries: one connect() is one attempt, and a transient
// failure destroys the socket (lib/connect.js). Hyperswarm one layer up treats
// exactly these codes as worth an immediate redial; Paseo uses raw hyperdht, so
// the transports run this ladder themselves. Pre-open only: once a stream is
// open, an error is a dropped connection, not a dial failure.
export const DHT_DIAL_TRANSIENT_CODES: Record<string, true> = {
  // Punch/probe failures. NAT mappings settle between attempts, and a phone in
  // doze can eat one ~10s probe window (lib/holepuncher.js) and then punch
  // cleanly on the very next dial.
  HOLEPUNCH_ABORTED: true,
  HOLEPUNCH_PROBE_TIMEOUT: true,
  HOLEPUNCH_DOUBLE_RANDOMIZED_NATS: true,
  CANNOT_HOLEPUNCH: true,
  REMOTE_NOT_HOLEPUNCHING: true,
  REMOTE_NOT_HOLEPUNCHABLE: true,
  // Lookup/transport races: announce propagation lags a daemon restart, and a
  // busy DHT node can fail an individual handshake round trip.
  PEER_NOT_FOUND: true,
  PEER_CONNECTION_FAILED: true,
  ETIMEDOUT: true,
  ECONNRESET: true,
};

/**
 * Attempts per connect, and the linear backoff between them (400/800/1200ms).
 * The outer DaemonClient reconnect loop supplies the longer spacing; these
 * attempts absorb single probe-window failures. Worst case is ~4 × the ~11s
 * abort window plus backoff, which the hyperdht connect budgets are sized for.
 */
export const DHT_DIAL_MAX_ATTEMPTS = 4;
export const DHT_DIAL_RETRY_BASE_MS = 400;

const textEncoder = new TextEncoder();

// ---- byte framing: [1B type][4B BE length][payload] ------------------------
export const PEER_FRAME_CONTROL = 0;
export const PEER_FRAME_TEXT = 1;
export const PEER_FRAME_BINARY = 2;
export type PeerFrameType = 0 | 1 | 2;

export function encodePeerFrame(type: PeerFrameType, payload: Uint8Array): Uint8Array {
  if (payload.length > DHT_MAX_FRAME_BYTES) throw new Error("peer frame too large");
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  out[1] = (payload.length >>> 24) & 0xff;
  out[2] = (payload.length >>> 16) & 0xff;
  out[3] = (payload.length >>> 8) & 0xff;
  out[4] = payload.length & 0xff;
  out.set(payload, 5);
  return out;
}

export function encodePeerTextFrame(text: string): Uint8Array {
  return encodePeerFrame(PEER_FRAME_TEXT, textEncoder.encode(text));
}

export function encodePeerBinaryFrame(bytes: Uint8Array): Uint8Array {
  return encodePeerFrame(PEER_FRAME_BINARY, bytes);
}

export interface DecodedPeerFrame {
  readonly type: PeerFrameType;
  readonly payload: Uint8Array;
}

/**
 * Length-prefixed frame decoder tolerant of stream chunk splitting.
 *
 * Chunks are queued rather than concatenated. A naive implementation that
 * re-merges the pending buffer on every push is quadratic in the frame size,
 * and UDX delivers a frame in ~1400-byte pieces: a 1 MiB message costs
 * hundreds of MiB of memcpy, on the phone's JS thread, at every hop. Here each
 * byte is copied at most once, and not at all when a frame arrives inside a
 * single chunk.
 */
export class PeerFrameDecoder {
  /** Pending chunks, oldest first; #head bytes of #chunks[0] are consumed. */
  #chunks: Uint8Array[] = [];
  #head = 0;
  /** Unconsumed bytes across all pending chunks. */
  #length = 0;

  push(chunk: Uint8Array): DecodedPeerFrame[] {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (bytes.length > 0) {
      this.#chunks.push(bytes);
      this.#length += bytes.length;
    }

    const out: DecodedPeerFrame[] = [];
    while (this.#length >= 5) {
      const type = this.#at(0) as PeerFrameType;
      const len = (this.#at(1) << 24) | (this.#at(2) << 16) | (this.#at(3) << 8) | this.#at(4);
      if (len < 0 || len > DHT_MAX_FRAME_BYTES) throw new Error("peer frame length out of range");
      if (this.#length < 5 + len) break;
      this.#consume(5);
      out.push({ type, payload: this.#read(len) });
    }
    return out;
  }

  /** Byte at logical offset `index`; only ever called for the 5-byte header. */
  #at(index: number): number {
    let remaining = index + this.#head;
    for (const chunk of this.#chunks) {
      if (remaining < chunk.length) return chunk[remaining]!;
      remaining -= chunk.length;
    }
    throw new Error("peer frame header read out of range");
  }

  #consume(count: number): void {
    this.#length -= count;
    this.#head += count;
    while (this.#chunks.length > 0 && this.#head >= this.#chunks[0]!.length) {
      this.#head -= this.#chunks[0]!.length;
      this.#chunks.shift();
    }
    if (this.#chunks.length === 0) this.#head = 0;
  }

  /** Take `len` bytes off the front, without copying when they are contiguous. */
  #read(len: number): Uint8Array {
    if (len === 0) return new Uint8Array(0);
    const first = this.#chunks[0]!;
    if (first.length - this.#head >= len) {
      const payload = first.subarray(this.#head, this.#head + len);
      this.#consume(len);
      return payload;
    }
    const payload = new Uint8Array(len);
    let written = 0;
    while (written < len) {
      const chunk = this.#chunks[0]!;
      const take = Math.min(len - written, chunk.length - this.#head);
      payload.set(chunk.subarray(this.#head, this.#head + take), written);
      written += take;
      this.#consume(take);
    }
    return payload;
  }
}
