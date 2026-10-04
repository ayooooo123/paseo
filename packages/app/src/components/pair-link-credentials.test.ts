import { describe, expect, it } from "vitest";
import { encodePeerInvite } from "@getpaseo/protocol/dht-peer";
import { PairingTargetTracker } from "./pair-link-credentials";

const PEER_A = encodePeerInvite({ publicKey: new Uint8Array(32).fill(1) });
const PEER_B = encodePeerInvite({ publicKey: new Uint8Array(32).fill(2) });

describe("pairing target password", () => {
  it("clears the password and hides its input when switching hosts", () => {
    const first = "relay://relay.example:443/srv_a?key=AAAA&ssl=true";
    const second = "relay://relay.example:443/srv_b?key=BBBB&ssl=true";
    const target = new PairingTargetTracker(first);
    expect(target.changeUrl("relay://relay.example:443/")).toBe(false);
    expect(target.changeUrl(second)).toBe(true);
    expect(target.changeUrl(second)).toBe(false);
  });

  it("clears the direct form credential when its advanced URI changes to a relay target", () => {
    const target = new PairingTargetTracker("", true);
    expect(target.changeUrl("relay://relay.example:443/srv_new?key=BBBB&ssl=true")).toBe(true);
  });

  it("keeps the password when a relay URI receives harmless whitespace", () => {
    const uri = "relay://relay.example:443/srv_a?key=AAAA&ssl=true";
    const target = new PairingTargetTracker(uri);
    expect(target.changeUrl(`${uri} `)).toBe(false);
  });

  it("recognizes a different host in an offer link after an incomplete edit", () => {
    const offer = Buffer.from(
      JSON.stringify({
        v: 2,
        serverId: "srv_b",
        daemonPublicKeyB64: "BBBB",
        relay: { endpoint: "relay.example:443" },
      }),
    ).toString("base64url");
    const target = new PairingTargetTracker("relay://relay.example:443/srv_a?key=AAAA");
    expect(target.changeUrl("https://app.paseo.sh/#offer=")).toBe(false);
    expect(target.changeUrl(`https://app.paseo.sh/#offer=${offer}`)).toBe(true);
  });

  it("clears the password when switching between a relay host and a HyperDHT peer", () => {
    const relay = "relay://relay.example:443/srv_a?key=AAAA&ssl=true";
    const target = new PairingTargetTracker(relay);
    expect(target.changeUrl(PEER_A)).toBe(true);
    expect(target.changeUrl(relay)).toBe(true);
  });

  it("clears the password for a different HyperDHT peer and keeps it for the same one", () => {
    const target = new PairingTargetTracker(PEER_A);
    expect(target.changeUrl(` ${PEER_A} `)).toBe(false);
    expect(target.changeUrl("paseo-peer://v1/")).toBe(false);
    expect(target.changeUrl(PEER_B)).toBe(true);
  });
});
