declare module "hyperdht" {
  export interface HyperDhtKeyPair {
    readonly publicKey: Buffer;
    readonly secretKey: Buffer;
  }

  export interface HyperDhtStream {
    /** streamx: no callback. Returns false above the high-water mark; wait for "drain". */
    write(data: Uint8Array): boolean;
    end(): void;
    destroy(error?: Error): void;
    on(event: "data", listener: (chunk: Buffer) => void): this;
    on(event: "open" | "end" | "close" | "connect" | "drain", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    once(event: string, listener: (...args: unknown[]) => void): this;
    removeListener(event: string, listener: (...args: unknown[]) => void): this;
    writableLength?: number;
    readonly remotePublicKey?: Buffer;
    /** The UDX stream underneath; its remote is the address the connection landed on. */
    readonly rawStream?: { readonly remoteHost: string; readonly remotePort: number };
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
      options?: {
        keyPair?: HyperDhtKeyPair;
        /** false disables hyperdht's same-public-IP LAN route. */
        localConnection?: boolean;
        /** Nodes to send the handshake to first; the server's own node connects direct. */
        relayAddresses?: ReadonlyArray<{ host: string; port: number }>;
      },
    ): HyperDhtStream;
    /** The DHT server socket's LAN-facing address (dht-rpc). */
    localAddress(): { host: string; port: number } | null;
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
