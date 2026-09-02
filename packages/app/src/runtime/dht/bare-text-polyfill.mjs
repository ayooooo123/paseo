// Ensure TextEncoder/TextDecoder exist before any module that instantiates them
// at load time (the dht-peer codec does). Imported first by dht-worker.mjs. The
// Bare runtime may already provide these; this is a defensive UTF-8 fallback.
if (typeof globalThis.TextEncoder === "undefined") {
  globalThis.TextEncoder = class {
    encode(input) {
      const bytes = unescape(encodeURIComponent(String(input)));
      const out = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i += 1) out[i] = bytes.charCodeAt(i);
      return out;
    }
  };
}
if (typeof globalThis.TextDecoder === "undefined") {
  globalThis.TextDecoder = class {
    decode(input) {
      const arr =
        input instanceof Uint8Array
          ? input
          : new Uint8Array(
              input.buffer ?? input,
              input.byteOffset ?? 0,
              input.byteLength ?? input.length,
            );
      let s = "";
      for (let i = 0; i < arr.length; i += 1) s += String.fromCharCode(arr[i]);
      return decodeURIComponent(escape(s));
    }
  };
}
