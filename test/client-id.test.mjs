import { test } from "node:test";
import assert from "node:assert/strict";
import { newId } from "../src/client-id.js";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Run with a crypto object that looks like the one a plain-HTTP page gets. */
function withoutRandomUUID(run) {
  const real = globalThis.crypto;
  const values = new Uint8Array([0x0f, 0x8e, 0x4c, 0x21, 0x9b, 0x7d, 0x31, 0xc4, 0x5a, 0x66, 0x08, 0xf2, 0x94, 0xb3, 0x1d, 0x7e]);
  Object.defineProperty(globalThis, "crypto", { value: {
    getRandomValues: target => { target.set(values.subarray(0, target.length)); return target; },
  }, configurable: true });
  try { return run(); } finally { Object.defineProperty(globalThis, "crypto", { value: real, configurable: true }); }
}

test("newId uses randomUUID when the page has it", () => {
  const id = newId();
  assert.match(id, V4);
});

test("newId still returns a valid v4 id without randomUUID (plain-HTTP origin)", () => {
  const id = withoutRandomUUID(() => newId());
  assert.match(id, V4, "a LAN address served over http has no crypto.randomUUID, yet ids are needed");
  // The version and variant nibbles come from the fallback's bit surgery, not the sampled bytes.
  assert.equal(id[14], "4");
  assert.match(id[19], /[89ab]/);
});

test("newId does not throw when crypto exists but randomUUID is missing", () => {
  assert.doesNotThrow(() => withoutRandomUUID(() => { for (let index = 0; index < 50; index++) newId(); }));
});

test("the built client bundle never calls crypto.randomUUID unguarded", async () => {
  const { readFile } = await import("node:fs/promises");
  const bundle = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  const calls = bundle.split("\n").filter(line => line.includes("crypto.randomUUID("));
  assert.ok(calls.length > 0, "the fast path should still be in the bundle");
  for (const line of calls) {
    // Every call must sit behind the typeof check, or a plain-HTTP origin throws on load.
    assert.match(line, /typeof crypto\??\.randomUUID === "function"/,
      `unguarded call in the client bundle: ${line.trim().slice(0, 120)}`);
  }
  assert.match(bundle, /getRandomValues/, "the fallback must survive bundling");
});
