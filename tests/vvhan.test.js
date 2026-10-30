import test from "node:test";
import assert from "node:assert/strict";
import { handleVvhan } from "../src/api/vvhan.js";

const last = "104.18.33.200:443#vvHan-CT-45ms\n";

function createEnv(backup = last) {
  const data = new Map(backup ? [["VVHAN_LAST", backup]] : []);
  const writes = [];
  return { data, writes, SUB_KV: {
    async get(key) { return data.get(key) || null; },
    async put(key, value) { writes.push([key, value]); data.set(key, value); },
  } };
}

test("vvhan TXT groups and deduplicates three-carrier IPv4 and saves a backup", async () => {
  const env = createEnv("");
  const response = await handleVvhan(env, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.4ce.cn/api/bestCFIP");
    assert.equal(options.headers.Accept, "application/json");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ success: true, data: { items: [
      { ip: "172.64.158.231", line: "CM", latency: 52.76 },
      { ip: "172.67.66.105", line: "CU", latency: null },
      { ip: "104.18.33.200", line: "CT", latency: 44.85 },
      { ip: "104.18.33.200", line: "CU", latency: 10 },
      { ip: "999.18.33.200", line: "CT" },
      { ip: "2a06:98c1::1", line: "IPV6" },
      { ip: "104.18.32.63", line: "ALL" },
    ] } });
  } });
  const expected = last + "172.67.66.105:443#vvHan-CU\n172.64.158.231:443#vvHan-CM-53ms\n";
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=300");
  assert.equal(response.headers.get("X-Vvhan-Source"), "live");
  assert.equal(await response.text(), expected);
  assert.equal(env.data.get("VVHAN_LAST"), expected);
});

test("unchanged vvhan output does not consume another KV write", async () => {
  const env = createEnv();
  await handleVvhan(env, { fetchImpl: async () => Response.json({ success: true, data: { items: [
    { ip: "104.18.33.200", line: "CT", latency: 45 },
  ] } }) });
  assert.equal(env.writes.length, 0);
});

for (const [reason, fetchImpl] of [
  ["upstream HTTP failure", async () => new Response("down", { status: 503 })],
  ["fetch timeout", async () => { throw new DOMException("timeout", "TimeoutError"); }],
  ["invalid JSON", async () => new Response("<html>down</html>")],
  ["API error", async () => Response.json({ success: false, data: { items: [] } })],
  ["empty candidate list", async () => Response.json({ success: true, data: { items: [] } })],
]) {
  test(`vvhan preserves the last good list on ${reason}`, async () => {
    const env = createEnv();
    const response = await handleVvhan(env, { fetchImpl });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Vvhan-Source"), "backup");
    assert.equal(await response.text(), last);
    assert.equal(env.writes.length, 0);
  });
}

test("vvhan still serves live results when KV is unavailable", async () => {
  const broken = async () => { throw new Error("KV unavailable"); };
  const response = await handleVvhan({ SUB_KV: { get: broken, put: broken } }, {
    fetchImpl: async () => Response.json({ success: true, data: { items: [
      { ip: "104.18.33.200", line: "CT", latency: 45 },
    ] } }),
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), last);
});

test("vvhan returns an uncached 503 if upstream and KV both fail or are absent", async () => {
  for (const env of [{}, { SUB_KV: { async get() { throw new Error("KV unavailable"); } } }]) {
    const response = await handleVvhan(env, { fetchImpl: async () => { throw new Error("offline"); } });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(await response.text(), "vvHan temporarily unavailable\n");
  }
});
