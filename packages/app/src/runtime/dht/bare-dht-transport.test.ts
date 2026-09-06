import { readFileSync } from "node:fs";
import vm from "node:vm";
import { transformSync } from "esbuild";
import { expect, it } from "vitest";
import * as codec from "@getpaseo/protocol/dht-peer";
import * as transportUtils from "@getpaseo/client/internal/daemon-client-transport-utils";
import type { createBareDhtTransportFactory } from "./bare-dht-transport.native";
import { FakeIpc, controlsFrom, encodeControl, flushMacrotasks } from "./dht-test-utils";

// Run the native adapter with controllable native IPC and lifecycle boundaries.
// Each VM owns a fresh session pool; the production module is not mocked.
function bridge() {
  const ipc = new FakeIpc();
  const output = {
    exports: {} as { createBareDhtTransportFactory: typeof createBareDhtTransportFactory },
  };
  const code = transformSync(
    readFileSync(new URL("./bare-dht-transport.native.ts", import.meta.url), "utf8"),
    { loader: "ts", format: "cjs" },
  ).code;
  vm.runInNewContext(code, {
    module: output,
    exports: output.exports,
    TextEncoder,
    TextDecoder,
    console,
    setTimeout,
    clearTimeout,
    require(name: string) {
      if (name === "@getpaseo/protocol/dht-peer") return codec;
      if (name === "@getpaseo/client/internal/daemon-client-transport-utils") return transportUtils;
      if (name === "./dht-client-identity") return { getDhtClientSeed: async () => null };
      if (name === "react-native")
        return { AppState: { addEventListener: () => ({ remove() {} }) } };
      if (name === "react-native-bare-kit")
        return {
          Worklet: class {
            IPC = ipc;
            start() {}
            suspend() {}
            resume() {}
            terminate() {}
          },
        };
      throw new Error(`Unexpected native dependency: ${name}`);
    },
  });
  const factory = output.exports.createBareDhtTransportFactory({
    invite: codec.encodePeerInvite({ publicKey: new Uint8Array(32).fill(7) }),
    workerBundle: "test boundary",
  });
  const connectId = () =>
    controlsFrom(ipc.out).findLast((value) => value.ipc === "connect")?.connectionId;
  return { ipc, factory, connectId, dispose: () => ipc.emitClose() };
}

it("drops queued controls and application bytes from a replaced stream", async () => {
  const { ipc, factory, connectId, dispose } = bridge();
  try {
    const first = factory({ url: "ws://unused" });
    await flushMacrotasks();
    const firstId = connectId();
    const second = factory({ url: "ws://unused" });
    await flushMacrotasks();
    const secondId = connectId();
    const events: unknown[] = [];
    second.onOpen(() => events.push("open"));
    second.onClose(() => events.push("close"));
    second.onError(() => events.push("error"));
    second.onMessage((data) => events.push(data));
    ipc.emitData(encodeControl({ ipc: "open", connectionId: firstId }));
    ipc.emitData(codec.encodePeerTextFrame("old server_info"));
    ipc.emitData(encodeControl({ ipc: "closed", connectionId: firstId }));
    ipc.emitData(
      encodeControl({ ipc: "error", connectionId: firstId, message: "old dial failed" }),
    );
    expect(events).toEqual([]);
    first.close();
    ipc.emitData(encodeControl({ ipc: "open", connectionId: secondId }));
    ipc.emitData(codec.encodePeerTextFrame("current server_info"));
    expect(events).toEqual(["open", "current server_info"]);
  } finally {
    dispose();
  }
});

it("a replaced open transport cannot send on the newer stream", async () => {
  const { ipc, factory, connectId, dispose } = bridge();
  try {
    const first = factory({ url: "ws://unused" });
    await flushMacrotasks();
    ipc.emitData(encodeControl({ ipc: "open", connectionId: connectId() }));
    const second = factory({ url: "ws://unused" });
    await flushMacrotasks();
    ipc.emitData(encodeControl({ ipc: "open", connectionId: connectId() }));
    expect(() => first.send("stale command")).toThrow("superseded");
    second.send("current command");
    const frames = new codec.PeerFrameDecoder();
    const sent = ipc.out.flatMap((chunk) => frames.push(chunk));
    expect(
      sent
        .filter((frame) => frame.type === codec.PEER_FRAME_TEXT)
        .map((frame) => new TextDecoder().decode(frame.payload)),
    ).toEqual(["current command"]);
  } finally {
    dispose();
  }
});

it("delivers only binary payload bytes from a pooled IPC buffer", async () => {
  const { ipc, factory, connectId, dispose } = bridge();
  try {
    const transport = factory({ url: "ws://unused" });
    await flushMacrotasks();
    const received: ArrayBuffer[] = [];
    transport.onMessage((data, binary) => {
      if (binary) received.push(data as ArrayBuffer);
    });
    const chunk = Buffer.concat([
      encodeControl({ ipc: "open", connectionId: connectId() }),
      codec.encodePeerBinaryFrame(new Uint8Array([11, 22])),
      codec.encodePeerBinaryFrame(new Uint8Array([33])),
    ]);
    ipc.emitData(chunk);
    chunk.fill(0);
    expect(received.map((data) => data.byteLength)).toEqual([2, 1]);
    expect(received).toEqual([new Uint8Array([11, 22]).buffer, new Uint8Array([33]).buffer]);
  } finally {
    dispose();
  }
});
