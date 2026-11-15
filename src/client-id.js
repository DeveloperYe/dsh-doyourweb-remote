/**
 * UUID v4 that also works outside a secure context.
 *
 * `crypto.randomUUID` exists only on HTTPS and on localhost, so a DSH instance served over plain
 * HTTP on a LAN address (http://192.168.1.10:3080) has no such function and the call throws
 * `crypto.randomUUID is not a function`. `crypto.getRandomValues` is available in insecure
 * contexts too, which is why the extension's annotator already builds its ids that way - this is
 * the same fallback for the client bundle.
 */
export function newId() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // RFC 4122 version 4: 4 in the version nibble, 10xx in the variant bits.
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
