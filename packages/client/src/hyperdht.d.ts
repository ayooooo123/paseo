declare module "hyperdht" {
  export interface HyperDhtKeyPair {
    readonly publicKey: Buffer;
    readonly secretKey: Buffer;
  }
  export interface HyperDhtStream {
    write(data: Uint8Array, callback?: (error?: Error | null) => void): boolean;
    end(): void;
    destroy(error?: Error): void;
    on(event: "data", listener: (chunk: Buffer) => void): this;
    on(event: "open" | "end" | "close" | "connect" | "drain", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    writableLength?: number;
  }
  export interface HyperDhtOptions {
    readonly bootstrap?: readonly string[];
  }
  export default class HyperDHT {
    constructor(options?: HyperDhtOptions);
    static keyPair(seed?: Buffer | Uint8Array): HyperDhtKeyPair;
    connect(
      publicKey: Buffer | Uint8Array,
      options?: {
        keyPair?: HyperDhtKeyPair;
        /** Nodes to send the handshake to first; the daemon's own node connects direct. */
        relayAddresses?: ReadonlyArray<{ host: string; port: number }>;
      },
    ): HyperDhtStream;
    destroy(): Promise<void>;
  }
}
