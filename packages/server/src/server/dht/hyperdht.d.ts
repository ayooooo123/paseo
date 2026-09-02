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
    once(event: string, listener: (...args: unknown[]) => void): this;
    writableLength?: number;
    readonly remotePublicKey?: Buffer;
  }

  export interface HyperDhtServer {
    on(event: "connection", listener: (stream: HyperDhtStream) => void): this;
    listen(keyPair?: HyperDhtKeyPair): Promise<void>;
    close(): Promise<void>;
    address(): { host: string; port: number; publicKey: Buffer } | null;
  }

  export interface HyperDhtServerOptions {
    readonly reusableSocket?: boolean;
    readonly firewall?: (
      remotePublicKey: Buffer,
      remotePayload: unknown,
    ) => boolean | Promise<boolean>;
  }

  export interface HyperDhtOptions {
    readonly bootstrap?: readonly string[];
  }

  export default class HyperDHT {
    constructor(options?: HyperDhtOptions);
    static keyPair(seed?: Buffer | Uint8Array): HyperDhtKeyPair;
    createServer(
      options?: HyperDhtServerOptions | ((stream: HyperDhtStream) => void),
      onconnection?: (stream: HyperDhtStream) => void,
    ): HyperDhtServer;
    connect(
      publicKey: Buffer | Uint8Array,
      options?: { keyPair?: HyperDhtKeyPair },
    ): HyperDhtStream;
    destroy(): Promise<void>;
  }
}

declare module "hyperdht/testnet.js" {
  interface Testnet {
    readonly bootstrap: string[];
    destroy(): Promise<void>;
  }
  export default function createTestnet(size?: number): Promise<Testnet>;
}
