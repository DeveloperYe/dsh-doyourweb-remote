import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserBridge } from "../src/bridge.js";

/** A connected browser as the bridge keeps it: profile plus the socket it arrived on. */
function fakeProfile(sourceId, { browser = "Edge", lastSeen = Date.now(), tabId = 7 } = {}) {
  const socket = { readyState: 1, lastSeen, connectedAt: lastSeen - 5000, remote: "127.0.0.1:1",
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/157.0.0.0 Safari/537.36 ${browser === "Edge" ? "Edg/157.0.0.0" : ""}`,
    tabCount: 1 };
  const profile = { id: sourceId, sourceId, sessionId: `${sourceId}-session`, ws: socket,
    tabs: new Map([[tabId, { id: tabId, ref: `dsh-browser://${sourceId}/${tabId}`, title: "Tab", url: "https://example.test/", browser }]]),
    browser };
  socket.sourceProfile = profile;
  return profile;
}

async function withBridge(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-default-browser-"));
  const bridge = new BrowserBridge({ home: path.join(root, "bridge"), port: 0 });
  t.after(async () => { await bridge.close().catch(() => {}); await rm(root, { recursive: true, force: true }); });
  return { bridge, root };
}

/** Answer dsh.openTab by publishing the tab the way the extension would. */
function stubOpen(bridge, profile) {
  const calls = [];
  bridge.request = async (target, method, params) => {
    calls.push({ target, method, params });
    profile.tabs.set(99, { id: 99, ref: `dsh-browser://${profile.sourceId}/99`, title: "New", url: "https://opened.test/", browser: profile.browser });
    return { tabId: 99 };
  };
  return calls;
}

test("the browser picked on the setup page wins over the freshest connection", async t => {
  const { bridge } = await withBridge(t);
  const older = fakeProfile("older-profile", { lastSeen: Date.now() - 60000 });
  const fresher = fakeProfile("fresher-profile", { lastSeen: Date.now() });
  bridge.profiles.set(older.id, older);
  bridge.profiles.set(fresher.id, fresher);
  const calls = stubOpen(bridge, older);

  await bridge.setDefaultBrowser(older.sourceId);
  const opened = await bridge.openTab(undefined, "https://opened.test/");
  assert.equal(opened.defaultUsed, true);
  assert.equal(calls[0].target.sourceId, "older-profile", "the default browser is used even though it is not the freshest");
});

test("without a default the freshest connection is still used", async t => {
  const { bridge } = await withBridge(t);
  const older = fakeProfile("older-profile", { lastSeen: Date.now() - 60000 });
  const fresher = fakeProfile("fresher-profile", { lastSeen: Date.now() });
  bridge.profiles.set(older.id, older);
  bridge.profiles.set(fresher.id, fresher);
  const calls = stubOpen(bridge, fresher);

  const opened = await bridge.openTab(undefined, "https://opened.test/");
  assert.equal(opened.defaultUsed, false);
  assert.equal(calls[0].target.sourceId, "fresher-profile");
});

test("a default browser that went offline falls back and says so", async t => {
  const { bridge } = await withBridge(t);
  const current = fakeProfile("current-profile");
  bridge.profiles.set(current.id, current);
  const calls = stubOpen(bridge, current);

  await bridge.setDefaultBrowser(current.sourceId);
  bridge.profiles.delete(current.id);
  bridge.profiles.set(current.id, current);
  // Forget the connection, keep the saved preference: the recorded default is now offline.
  const saved = bridge.preferences.defaultBrowser;
  bridge.profiles.clear();
  bridge.profiles.set(current.id, current);
  bridge.preferences = { defaultBrowser: { ...saved, profileId: "gone-profile" } };

  const opened = await bridge.openTab(undefined, "https://opened.test/");
  assert.equal(opened.defaultUsed, false);
  assert.equal(opened.defaultMissing, true, "the caller is told the configured default is not connected");
  assert.equal(calls[0].target.sourceId, "current-profile");
});

test("the choice is written to preferences.json and read back on the next start", async t => {
  const { bridge, root } = await withBridge(t);
  const profile = fakeProfile("persisted-profile");
  bridge.profiles.set(profile.id, profile);
  await bridge.setDefaultBrowser(profile.sourceId);

  const stored = JSON.parse(await readFile(path.join(root, "bridge", "preferences.json"), "utf8"));
  assert.equal(stored.defaultBrowser.profileId, "persisted-profile");
  assert.equal(stored.defaultBrowser.browser, "Edge");

  const reopened = new BrowserBridge({ home: path.join(root, "bridge"), port: 0 });
  t.after(async () => { await reopened.close().catch(() => {}); });
  await reopened.prepareExtension();
  reopened.profiles.set(profile.id, profile);
  assert.equal(reopened.defaultBrowser?.sourceId, "persisted-profile", "the preference survives a restart");
});

test("choosing a browser that is not connected is refused", async t => {
  const { bridge } = await withBridge(t);
  await assert.rejects(bridge.setDefaultBrowser("no-such-profile"), /not connected any more/);
  assert.equal(bridge.defaultBrowser, undefined);
});

test("the setup page offers the chooser and marks the default", async t => {
  const { bridge } = await withBridge(t);
  const first = fakeProfile("first-profile");
  const second = fakeProfile("second-profile", { browser: "Chrome" });
  bridge.profiles.set(first.id, first);
  bridge.profiles.set(second.id, second);
  bridge.connections.add(first.ws);
  bridge.connections.add(second.ws);
  await bridge.setDefaultBrowser(second.sourceId);

  const html = bridge.connectionsSection();
  assert.match(html, /设为默认/, "the other browsers get a button");
  assert.equal((html.match(/设为默认/g) || []).length, 1, "only the non-default row offers it");
  assert.match(html, /badge online">默认</, "the chosen browser is marked");
  assert.match(html, /value="first-profile"/, "the button posts the profile it belongs to");
});

test("POST /setup/default stores the choice and redirects back", async t => {
  const { bridge } = await withBridge(t);
  await bridge.start();
  const profile = fakeProfile("posted-profile");
  bridge.profiles.set(profile.id, profile);

  const port = bridge.port;
  const response = await new Promise((resolve, reject) => {
    const call = httpRequest({ host: "127.0.0.1", port, path: `/setup/default?k=${bridge.manageSecret}`, method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" } },
    res => { res.resume(); res.on("end", () => resolve(res)); });
    call.on("error", reject);
    call.end("sourceId=posted-profile");
  });
  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.location, "/setup");
  assert.equal(bridge.defaultBrowser?.sourceId, "posted-profile");
});

test("a cross-site POST cannot change the default browser", async t => {
  const { bridge } = await withBridge(t);
  await bridge.start();
  const profile = fakeProfile("guarded-profile");
  bridge.profiles.set(profile.id, profile);

  const response = await new Promise((resolve, reject) => {
    const call = httpRequest({ host: "127.0.0.1", port: bridge.port, path: `/setup/default?k=${bridge.manageSecret}`, method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" } },
    res => { res.resume(); res.on("end", () => resolve(res)); });
    call.on("error", reject);
    call.end("sourceId=guarded-profile");
  });
  assert.equal(response.statusCode, 403);
  assert.equal(bridge.defaultBrowser, undefined, "nothing was recorded");
});
