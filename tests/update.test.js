import test from "node:test";
import assert from "node:assert/strict";
import { checkCandidates, parseCfRayColo } from "../scripts/lib/check.js";
import { collectCandidates, collectCandidatesWithHealth, expandIPv4Cidr, expandIPv6Cidr, parseCandidate, parseCsv, uniqueCandidates } from "../scripts/lib/candidates.js";
import { deleteKvValue, readKvValue, writeKvValue } from "../scripts/lib/kv.js";
import { aggregateCheckedResults, buildUpdatePayload } from "../scripts/update-kv.js";

test("parse candidates from IP, host:port and URL", () => {
  assert.deepEqual(parseCandidate("1.1.1.1"), { address: "1.1.1.1", port: null });
  assert.deepEqual(parseCandidate("example.com:8443"), { address: "example.com", port: 8443 });
  assert.deepEqual(parseCandidate("https://node.example.com:8443"), { address: "node.example.com", port: 8443 });
  assert.deepEqual(parseCandidate("[2606:4700::6810:85e5]:443"), { address: "2606:4700::6810:85e5", port: 443 });
  assert.deepEqual(parseCandidate("2606:4700::6810:85e5"), { address: "2606:4700::6810:85e5", port: null });
  assert.equal(parseCandidate(""), null);
});

test("expand IPv4 CIDR into sampled edge candidates", () => {
  const result = expandIPv4Cidr("1.1.1.0/30", 4);

  assert.deepEqual(result, [
    { address: "1.1.1.1", port: null },
    { address: "1.1.1.2", port: null },
  ]);
});

test("expand IPv4 CIDR into sampled edge candidates with more samples", () => {
  const result = expandIPv4Cidr("1.1.1.0/28", 6);

  assert.deepEqual(result, [
    { address: "1.1.1.1", port: null },
    { address: "1.1.1.3", port: null },
    { address: "1.1.1.6", port: null },
    { address: "1.1.1.8", port: null },
    { address: "1.1.1.11", port: null },
    { address: "1.1.1.14", port: null },
  ]);
});

test("deduplicate candidates", () => {
  const result = uniqueCandidates([
    { address: "1.1.1.1", port: null },
    { address: "1.1.1.1", port: null },
    { address: "1.1.1.1", port: 443 },
  ]);

  assert.equal(result.length, 2);
});

test("collect candidates from manual and remote sources", async () => {
  const result = await collectCandidates({
    manualText: "1.1.1.1\nexample.com:443",
    remoteSources: [{ name: "remote", url: "https://source.example/list.txt" }],
    fetchImpl: async () => new Response("2.2.2.2\nhttps://node.example:8443/path"),
  });

  assert.deepEqual(result.map((item) => `${item.address}:${item.port || ""}`), [
    "1.1.1.1:",
    "example.com:443",
    "2.2.2.2:",
    "node.example:8443",
  ]);
});

test("collect candidates expands IPv6 CIDR from Cloudflare official source", async () => {
  const result = await collectCandidates({
    manualText: "",
    remoteSources: [{ name: "cloudflare-official-v6", url: "https://www.cloudflare.com/ips-v6/", type: "text", cidrSamples: 2 }],
    fetchImpl: async () => new Response("2400:cb00::/32\n2606:4700::/32"),
  });

  assert.equal(result.length, 4);
  assert.ok(result.every((item) => item.address.includes(":")));
  assert.ok(result.every((item) => item.port === null));
  assert.deepEqual(result.map((item) => item.source), ["cloudflare-official-v6", "cloudflare-official-v6", "cloudflare-official-v6", "cloudflare-official-v6"]);
});

test("collect vvhan data.items as candidates without trusting upstream measurements", async () => {
  const result = await collectCandidatesWithHealth({
    remoteSources: [{ name: "vvhan-bestcfip", url: "https://api.4ce.cn/api/bestCFIP", type: "json", cfOnly: true }],
    fetchImpl: async () => Response.json({
      success: true,
      data: { items: [
        { ip: "104.18.33.200", line: "CT", latency: 45, speed: 1, loss: 0 },
        { ip: "172.67.66.105", line: "CU" },
        { ip: "172.64.158.231", line: "CM" },
        { ip: "172.64.229.247", line: "ALL" },
        { ip: "2a06:98c1::1", line: "IPV6" },
        { ip: "2a06:98c1::1", line: "IPV6" },
        { ip: "8.8.8.8", line: "CT" },
      ] },
    }),
  });

  assert.deepEqual(result.candidates, [
    "104.18.33.200", "172.67.66.105", "172.64.158.231", "172.64.229.247", "2a06:98c1::1",
  ].map((address) => ({ address, port: null, source: "vvhan-bestcfip" })));
  assert.equal(result.sourceHealth.find((item) => item.name === "vvhan-bestcfip").candidates, 7);
  assert.equal(result.dropped.notCloudflare, 1);
});

test("collect candidates from CloudflareSpeedTest CSV source", async () => {
  const csv = [
    "IP地址,端口,回源端口,TLS,数据中心,地区,城市,TCP延迟(ms),速度(MB/s)",
    "141.147.162.204,443,443,true,NRT,Asia Pacific,Tokyo,73,11.59",
    "141.147.162.205,443,443,true,NRT,Asia Pacific,Tokyo,80,3.2",
  ].join("\n");

  const result = await collectCandidates({
    remoteSources: [{ name: "csv", url: "https://source.example/addressescsv.csv", type: "csv", minSpeed: 8 }],
    fetchImpl: async () => new Response(csv),
  });

  assert.deepEqual(result, [{
    address: "141.147.162.204",
    port: 443,
    source: "csv",
    tls: true,
    colo: "NRT",
    speed: 11.59,
    remark: "Tokyo",
  }]);
});

test("parse Cloudflare ray colo", () => {
  assert.equal(parseCfRayColo("973bbddc7e2210a8-LAX"), "LAX");
  assert.equal(parseCfRayColo("bad-value"), "");
});

test("P1-8 checkCandidates measures jitter across samples", async () => {
  const latencies = [10, 20, 30];
  let call = 0;
  const result = await checkCandidates(
    [{ address: "a.example", port: 443 }],
    [443],
    {
      jitterSamples: 3,
      checkOne: async () => ({ latency: latencies[call++ % latencies.length], colo: "LAX", edgeVerified: true }),
    },
  );
  // stddev(10,20,30) = sqrt(200/3) ≈ 8.2；保留最优（最小）延迟
  assert.equal(result[0].jitter, 8.2);
  assert.equal(result[0].latency, 10);
});

test("P1-8 checkCandidates defaults to single sample with zero jitter", async () => {
  const result = await checkCandidates(
    [{ address: "a.example", port: 443 }],
    [443],
    { checkOne: async () => ({ latency: 42, colo: "LAX", edgeVerified: true }) },
  );
  assert.equal(result[0].jitter, 0);
  assert.equal(result[0].latency, 42);
});

test("check candidates sorts by latency, expands ports and keeps colo", async () => {
  const result = await checkCandidates(
    [{ address: "a.example", port: null }],
    [443, 8443],
    {
      checkOne: async (address, port) => (port === 443 ? { latency: 20, colo: "LAX", edgeVerified: true } : { latency: 10, colo: "SJC", edgeVerified: true }),
    },
  );

  assert.deepEqual(result.map((item) => item.port), [8443, 443]);
  assert.equal(result[0].colo, "SJC");
  assert.equal(result[0].edgeVerified, true);
});

test("check candidates sorts by speed descending when bandwidth data present", async () => {
  // 模拟国内场景：延迟低但带宽低的节点 应排在 延迟高但带宽高的节点 之后
  const candidates = [
    { address: "low-latency", port: 443, speed: 3.2 },   // 低带宽
    { address: "high-bandwidth", port: 443, speed: 11.6 }, // 高带宽
    { address: "no-speed", port: 443 },                   // 无带宽数据
  ];
  const result = await checkCandidates(candidates, [443], {
    checkOne: async (address) => ({
      latency: address === "low-latency" ? 12 : address === "high-bandwidth" ? 73 : 50,
      colo: "NRT",
      edgeVerified: true,
    }),
  });

  // 高带宽排第一，低带宽第二，无带宽排最后
  assert.deepEqual(result.map((item) => item.address), ["high-bandwidth", "low-latency", "no-speed"]);
  assert.equal(result[0].speed, 11.6);
});

test("check candidates falls back to latency when no speed data", async () => {
  const result = await checkCandidates(
    [{ address: "a.example", port: null }],
    [443, 8443],
    {
      checkOne: async (address, port) => (port === 443 ? { latency: 20, colo: "LAX", edgeVerified: true } : { latency: 10, colo: "SJC", edgeVerified: true }),
    },
  );

  assert.deepEqual(result.map((item) => item.port), [8443, 443]);
});

test("check candidates can require Cloudflare ray verification", async () => {
  const result = await checkCandidates(
    [{ address: "a.example", port: 443 }],
    [443],
    {
      requireCfRay: true,
      allowTcpOnly: false,
      checkOne: async () => ({ latency: 5, colo: "", edgeVerified: false }),
    },
  );

  assert.deepEqual(result, []);
});

test("aggregate checked results groups ports per address and prefers 443", () => {
  const pooled = aggregateCheckedResults([
    { address: "1.1.1.1", port: 8443, latency: 9, colo: "LAX", edgeVerified: true, source: "s" },
    { address: "1.1.1.1", port: 443, latency: 30, colo: "LAX", edgeVerified: true, source: "s" },
    { address: "2.2.2.2", port: 2087, latency: 12, colo: "SJC", edgeVerified: false, source: "s" },
  ]);

  assert.equal(pooled.length, 2);
  assert.equal(pooled[0].port, 443);
  assert.deepEqual(pooled[0].ports, [443, 8443]);
  assert.equal(pooled[0].latency, 30);
  assert.equal(pooled[0].edgeVerified, true);
  assert.deepEqual(pooled[1].ports, [2087]);
});

test("build update payload stores pooled checked nodes with colo names", async () => {
  const payload = await buildUpdatePayload({
    nodeConfig: { sni: "example.com", host: "example.com", security: "tls" },
    manualText: Array.from({ length: 60 }, (_, index) => `1.1.1.${index + 1}`).join("\n"),
    remoteSources: [],
    checkOne: async (address) => ({ latency: Number(address.split(".").at(-1)), colo: "LAX", edgeVerified: true }),
    downloadSpeedImpl: async () => null,
    now: new Date("2026-06-03T00:00:00.000Z"),
  });
  const bestIps = JSON.parse(payload.BEST_IPS);
  const status = JSON.parse(payload.STATUS);

  assert.equal(payload.TEMPLATE, undefined);
  assert.equal(bestIps.length, 60);
  assert.equal(bestIps[0].address, "1.1.1.1");
  assert.equal(bestIps[0].port, 443);
  assert.deepEqual(bestIps[0].ports, [443, 2053, 2083, 2087, 2096, 8443]);
  assert.equal(bestIps[0].name, "🌐 未实测 #1");
  assert.equal(bestIps[0].colo, "LAX");
  assert.equal(bestIps[0].speed, null);
  assert.equal(status.updatedAt, "2026-06-03T00:00:00.000Z");
  assert.equal(status.available, 60);
  assert.equal(status.protectedByPrevious, false);
  assert.equal(status.requireCfRay, true);
  assert.equal(status.allowTcpOnly, false);
  assert.equal(status.averageSpeed, null);
  assert.equal(JSON.parse(payload.SOURCE_HEALTH).length, 1);
  assert.equal(payload.LAST_RUN_AT, "2026-06-03T00:00:00.000Z");
  assert.equal(payload.LAST_RUN_OK, "true");
  assert.equal(payload.LAST_RUN_AVAILABLE, "60");
  assert.equal(JSON.parse(payload.BEST_IPS_LAST).length, 60);
  assert.equal(JSON.parse(payload.BEST_IPS_TREND).length, 1);
  assert.equal(status.available, 60);
});

test("build update payload caps pool size by poolLimit", async () => {
  const payload = await buildUpdatePayload({
    nodeConfig: { sni: "example.com", host: "example.com", security: "tls" },
    manualText: Array.from({ length: 10 }, (_, index) => `1.1.1.${index + 1}`).join("\n"),
    remoteSources: [],
    poolLimit: 3,
    checkOne: async (address) => ({ latency: Number(address.split(".").at(-1)), colo: "LAX", edgeVerified: true }),
    downloadSpeedImpl: async () => null,
    now: new Date("2026-06-03T00:00:00.000Z"),
  });
  const bestIps = JSON.parse(payload.BEST_IPS);

  assert.equal(bestIps.length, 3);
  assert.deepEqual(bestIps.map((item) => item.address), ["1.1.1.1", "1.1.1.2", "1.1.1.3"]);
});

test("build update payload records speed when CSV source provides bandwidth", async () => {
  const csv = [
    "IP地址,端口,回源端口,TLS,数据中心,地区,城市,TCP延迟(ms),速度(MB/s)",
    "141.147.162.204,443,443,true,NRT,Asia Pacific,Tokyo,73,11.59",
    "130.61.203.115,443,443,true,FRA,Europe,Frankfurt,195,5.0",
  ].join("\n");
  const payload = await buildUpdatePayload({
    nodeConfig: { sni: "example.com", host: "example.com", security: "tls" },
    remoteSources: [{ name: "csv", url: "https://source.example/addressescsv.csv", type: "csv", minSpeed: 0 }],
    checkOne: async (address) => ({ latency: 50, colo: "NRT", edgeVerified: true }),
    downloadSpeedImpl: async () => null,
    fetchImpl: async () => new Response(csv),
    now: new Date("2026-06-03T00:00:00.000Z"),
  });
  const bestIps = JSON.parse(payload.BEST_IPS);
  const status = JSON.parse(payload.STATUS);

  // 高带宽节点应排在前面
  assert.deepEqual(bestIps.map((item) => item.address), ["141.147.162.204", "130.61.203.115"]);
  assert.equal(bestIps[0].speed, 11.59);
  assert.equal(bestIps[1].speed, 5.0);
  assert.equal(status.averageSpeed, 8); // (11.59 + 5.0) / 2 ≈ 8.3 → 8
});

test("P2-10 build update payload writes measured bandwidth over CSV speed", async () => {  const seen = [];
  const payload = await buildUpdatePayload({
    nodeConfig: { sni: "example.com", host: "example.com", security: "tls" },
    manualText: "1.1.1.1\n2.2.2.2",
    remoteSources: [],
    checkOne: async () => ({ latency: 10, colo: "LAX", edgeVerified: true }),
    downloadSpeedImpl: async (address, port, { bytes, timeoutMs }) => {
      seen.push({ address, port, bytes, timeoutMs });
      return address === "1.1.1.1" ? 88.8 : null;
    },
    now: new Date("2026-06-03T00:00:00.000Z"),
  });
  const bestIps = JSON.parse(payload.BEST_IPS);

  assert.deepEqual(seen.map((item) => item.address).sort(), ["1.1.1.1", "2.2.2.2"]);
  assert.equal(seen[0].bytes, 1000000);
  assert.equal(seen[0].timeoutMs, 15000);
  assert.equal(bestIps.find((node) => node.address === "1.1.1.1").speed, 88.8);
  // 测速失败不阻断：保留原值（此处无 CSV speed，故为 null）
  assert.equal(bestIps.find((node) => node.address === "2.2.2.2").speed, null);
});

test("P2-6 build update payload diverts IPv6 candidates to BEST_IPS_V6 untested", async () => {
  const checkedAddresses = [];
  const payload = await buildUpdatePayload({
    nodeConfig: { sni: "example.com", host: "example.com", security: "tls" },
    manualText: "1.1.1.1\n2400:cb00::1",
    remoteSources: [],
    checkOne: async (address) => {
      checkedAddresses.push(address);
      return { latency: 10, colo: "LAX", edgeVerified: true };
    },
    downloadSpeedImpl: async () => null,
    now: new Date("2026-06-03T00:00:00.000Z"),
  });
  const bestIps = JSON.parse(payload.BEST_IPS);
  const v6Pool = JSON.parse(payload.BEST_IPS_V6);

  // IPv6 不进 check（v4 该有的两轮探测都在）
  assert.ok(checkedAddresses.length > 0);
  assert.ok(checkedAddresses.every((address) => address === "1.1.1.1"));
  assert.ok(bestIps.every((node) => !node.address.includes(":")));
  assert.equal(v6Pool.length, 1);
  assert.equal(v6Pool[0].address, "2400:cb00::1");
  assert.equal(v6Pool[0].untested6, true);
  assert.equal(v6Pool[0].port, 443);
});

test("build update payload keeps previous nodes when new result is too small", async () => {
  const previousBestIps = [{ address: "9.9.9.9", port: 443, name: "旧节点" }];
  const payload = await buildUpdatePayload({
    nodeConfig: { sni: "example.com", host: "example.com", security: "tls" },
    manualText: "1.1.1.1",
    remoteSources: [],
    previousBestIps,
    previousStatus: { consecutiveFallbacks: 2, lastSuccessfulRefreshAt: "2026-06-02T00:00:00.000Z" },
    checkOne: async () => ({ latency: 10, colo: "LAX", edgeVerified: true }),
    downloadSpeedImpl: async () => null,
    now: new Date("2026-06-03T00:00:00.000Z"),
  });
  const bestIps = JSON.parse(payload.BEST_IPS);
  const status = JSON.parse(payload.STATUS);

  assert.deepEqual(bestIps, previousBestIps);
  assert.equal(status.available, 1);
  // 新口径按地址计：一台 IP 多个端口只算一个池成员
  assert.equal(status.newAvailable, 1);
  assert.equal(status.lastRawAvailable, 1);
  assert.equal(status.consecutiveFallbacks, 3);
  assert.equal(status.lastSuccessfulRefreshAt, "2026-06-02T00:00:00.000Z");
  assert.equal(status.protectedByPrevious, true);
  assert.match(status.lastError, /已保留上次可用结果/);
});

test("build update payload keeps version index bounded", async () => {
  const previousVersionIndex = Array.from({ length: 31 }, (_, index) => `BEST_IPS_OLD_${String(index).padStart(2, "0")}`);
  const payload = await buildUpdatePayload({
    nodeConfig: { sni: "example.com", host: "example.com", security: "tls" },
    manualText: "1.1.1.1\n1.1.1.2\n1.1.1.3\n1.1.1.4\n1.1.1.5\n1.1.1.6\n1.1.1.7\n1.1.1.8\n1.1.1.9\n1.1.1.10\n1.1.1.11\n1.1.1.12\n1.1.1.13\n1.1.1.14\n1.1.1.15\n1.1.1.16\n1.1.1.17\n1.1.1.18\n1.1.1.19\n1.1.1.20",
    remoteSources: [],
    previousVersionIndex,
    checkOne: async (address) => ({ latency: Number(address.split(".").at(-1)), colo: "LAX", edgeVerified: true }),
    downloadSpeedImpl: async () => null,
    now: new Date("2026-06-03T00:00:00.000Z"),
  });

  const index = JSON.parse(payload.BEST_IPS_VERSION_INDEX);
  const expired = JSON.parse(payload.BEST_IPS_EXPIRED_VERSIONS);
  assert.equal(index.length, 30);
  assert.equal(index[0], "BEST_IPS_20260603T000000Z");
  assert.deepEqual(expired, ["BEST_IPS_OLD_29", "BEST_IPS_OLD_30"]);
});

test("collect candidates records source health and rejects oversized source", async () => {  const result = await collectCandidatesWithHealth({
    manualText: "1.1.1.1",
    remoteSources: [
      { name: "ok-source", url: "https://source.example/ok.txt" },
      { name: "large-source", url: "https://source.example/large.txt", maxBytes: 5 },
      { name: "bad-source", url: "https://source.example/bad.txt" },
    ],
    fetchImpl: async (url) => {
      if (url.includes("ok")) return new Response("2.2.2.2\n3.3.3.3", { status: 200 });
      if (url.includes("large")) return new Response("123456789", { status: 200 });
      return new Response("server error", { status: 500 });
    },
  });

  assert.deepEqual(result.candidates.map((item) => item.address), ["1.1.1.1", "2.2.2.2", "3.3.3.3"]);
  assert.equal(result.sourceHealth.find((item) => item.name === "edge-manual").ok, true);
  assert.equal(result.sourceHealth.find((item) => item.name === "ok-source").candidates, 2);
  assert.equal(result.sourceHealth.find((item) => item.name === "large-source").ok, false);
  assert.match(result.sourceHealth.find((item) => item.name === "large-source").error, /source too large/);
  assert.equal(result.sourceHealth.find((item) => item.name === "bad-source").status, 500);
});

test("P0-1 collect candidates passes abort signal and isolates source failures", async () => {
  const seenSignals = [];
  const result = await collectCandidatesWithHealth({
    manualText: "",
    remoteSources: [
      { name: "slow-fail", url: "https://source.example/slow.txt" },
      { name: "fast", url: "https://source.example/fast.txt" },
    ],
    fetchImpl: async (url, init) => {
      seenSignals.push(!!init?.signal);
      if (url.includes("fast")) return new Response("9.9.9.9");
      throw new Error("boom");
    },
  });

  assert.deepEqual(seenSignals, [true, true]);
  assert.ok(result.candidates.some((item) => item.address === "9.9.9.9"));
  assert.equal(result.sourceHealth.find((item) => item.name === "slow-fail").ok, false);
  assert.equal(result.sourceHealth.find((item) => item.name === "slow-fail").error, "boom");
  assert.equal(result.sourceHealth.find((item) => item.name === "fast").ok, true);
});

test("P0-1 collect candidates fetches remote sources in parallel", async () => {
  const started = Date.now();
  await collectCandidatesWithHealth({
    manualText: "",
    remoteSources: [
      { name: "a", url: "https://source.example/a.txt" },
      { name: "b", url: "https://source.example/b.txt" },
    ],
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return new Response("1.1.1.1");
    },
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 550, `expected parallel fetch (<550ms), took ${elapsed}ms`);
});

test("P0-1 collect candidates aborts a hanging source via timeout", async () => {
  const result = await collectCandidatesWithHealth({
    manualText: "",
    remoteSources: [
      { name: "hang", url: "https://source.example/hang.txt" },
      { name: "fast", url: "https://source.example/fast.txt" },
    ],
    fetchImpl: (url, init) => {
      if (url.includes("fast")) return Promise.resolve(new Response("8.8.8.8"));
      return new Promise((_, reject) => {
        // emulate AbortSignal.timeout firing without waiting 10s in test
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        queueMicrotask(() => init?.signal?.dispatchEvent(new Event("abort")));
      });
    },
  });

  assert.ok(result.candidates.some((item) => item.address === "8.8.8.8"));
  const hang = result.sourceHealth.find((item) => item.name === "hang");
  assert.equal(hang.ok, false);
  assert.match(hang.error, /abort/i);
});

test("P0-2 parseCsv finds columns by header name regardless of order", () => {
  const csv = [
    "速度(MB/s),数据中心,端口,IP地址,TLS",
    "11.59,NRT,443,141.147.162.204,true",
  ].join("\n");

  const result = parseCsv(csv, "csv", 8);
  assert.deepEqual(result, [{
    address: "141.147.162.204",
    port: 443,
    source: "csv",
    tls: true,
    colo: "NRT",
    speed: 11.59,
  }]);
});

test("P0-2 parseCsv falls back to fixed indices when header is unknown", () => {
  const csv = [
    "a,b,c,d,e,f,g,h,i",
    "141.147.162.204,443,443,true,NRT,xx,yy,zz,11.59",
  ].join("\n");

  const result = parseCsv(csv, "csv", 8);
  assert.deepEqual(result, [{
    address: "141.147.162.204",
    port: 443,
    source: "csv",
    tls: true,
    colo: "NRT",
    speed: 11.59,
  }]);
});

test("P0-2 parseCsv honors remarkColumn option", () => {
  const csv = [
    "IP地址,端口,回源端口,TLS,数据中心,城市,速度(MB/s)",
    "141.147.162.204,443,443,true,NRT,Tokyo,11.59",
  ].join("\n");

  const result = parseCsv(csv, "csv", 0, { remarkColumn: 5 });
  assert.equal(result[0].remark, "Tokyo");
});


test("build update payload honors source max bytes and version retention options", async () => {  const previousVersionIndex = ["BEST_IPS_A", "BEST_IPS_B", "BEST_IPS_C"];
  const payload = await buildUpdatePayload({
    nodeConfig: { sni: "example.com", host: "example.com", security: "tls" },
    manualText: Array.from({ length: 20 }, (_, index) => `1.1.1.${index + 1}`).join("\n"),
    remoteSources: [{ name: "too-large", url: "https://source.example/large.txt" }],
    previousVersionIndex,
    maxSourceBytes: 5,
    versionRetention: 2,
    fetchImpl: async () => new Response("123456789", { status: 200 }),
    checkOne: async (address) => ({ latency: Number(address.split(".").at(-1)), colo: "LAX", edgeVerified: true }),
    downloadSpeedImpl: async () => null,
    now: new Date("2026-06-03T00:00:00.000Z"),
  });

  const sourceHealth = JSON.parse(payload.SOURCE_HEALTH);
  assert.equal(sourceHealth.find((item) => item.name === "too-large").ok, false);
  assert.match(sourceHealth.find((item) => item.name === "too-large").error, /source too large/);
  assert.equal(JSON.parse(payload.BEST_IPS_VERSION_INDEX).length, 2);
  assert.deepEqual(JSON.parse(payload.BEST_IPS_EXPIRED_VERSIONS), ["BEST_IPS_B", "BEST_IPS_C"]);
});

test("read KV value returns text or null for missing key", async () => {
  const ok = await readKvValue({
    accountId: "account-id",
    namespaceId: "namespace-id",
    apiToken: "secret-token",
    key: "BEST_IPS",
    fetchImpl: async () => new Response("[]", { status: 200 }),
  });
  const missing = await readKvValue({
    accountId: "account-id",
    namespaceId: "namespace-id",
    apiToken: "secret-token",
    key: "BEST_IPS",
    fetchImpl: async () => new Response("not found", { status: 404 }),
  });

  assert.equal(ok, "[]");
  assert.equal(missing, null);
});

test("write KV value calls Cloudflare API without exposing secrets", async () => {
  let captured;
  await writeKvValue({
    accountId: "account-id",
    namespaceId: "namespace-id",
    apiToken: "secret-token",
    key: "BEST_IPS",
    value: "[]",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response("{}", { status: 200 });
    },
  });

  assert.match(captured.url, /accounts\/account-id\/storage\/kv\/namespaces\/namespace-id\/values\/BEST_IPS/);
  assert.equal(captured.options.method, "PUT");
  assert.equal(captured.options.body, "[]");
  assert.equal(captured.options.headers.Authorization, "Bearer secret-token");
});

test("delete KV value calls Cloudflare API", async () => {
  let captured;
  await deleteKvValue({
    accountId: "account-id",
    namespaceId: "namespace-id",
    apiToken: "secret-token",
    key: "BEST_IPS_OLD",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response("{}", { status: 200 });
    },
  });

  assert.match(captured.url, /values\/BEST_IPS_OLD/);
  assert.equal(captured.options.method, "DELETE");
  assert.equal(captured.options.headers.Authorization, "Bearer secret-token");
});
import { filterEdgeCandidates as filterEdgeCandidatesForTest } from "../scripts/lib/candidates.js";

test("cfOnly 源只保留 Cloudflare 官方段 IPv4，域名保留，黑名单生效", () => {
  const input = [
    { address: "104.16.1.1", port: 443, source: "community" },
    { address: "150.230.206.130", port: 443, source: "community" },
    { address: "cf.example.com", port: 443, source: "community" },
    { address: "150.230.206.131", port: 443, source: "edge-manual" },
    { address: "172.64.9.9", port: 443, source: "edge-manual" },
  ];
  const { candidates, dropped } = filterEdgeCandidatesForTest(input, {
    cfOnlySources: new Set(["community"]),
    blacklist: ["172.64.9.0/24"],
  });
  assert.deepEqual(candidates.map((c) => c.address), ["104.16.1.1", "cf.example.com", "150.230.206.131"]);
  assert.deepEqual(dropped, { blacklisted: 1, notCloudflare: 1 });
});

test("手动置顶条目扫描不过审也保留在池里", async () => {
  const payload = await buildUpdatePayload({
    nodeConfig: { sni: "example.com", host: "example.com", security: "tls" },
    manualText: ["1.1.1.1", "9.9.9.9:2053"].join("\n"),
    remoteSources: [],
    checkOne: async (address) => (address === "1.1.1.1" ? { latency: 5, colo: "LAX", edgeVerified: true } : null),
    downloadSpeedImpl: async () => null,
    now: new Date("2026-10-12T00:00:00Z"),
  });
  const bestIps = JSON.parse(payload.BEST_IPS);
  const pinned = bestIps.find((item) => item.address === "9.9.9.9");
  assert.ok(pinned);
  assert.equal(pinned.port, 2053);
  assert.equal(pinned.edgeVerified, false);
  assert.equal(pinned.source, "edge-manual");
});

test("cfOnly 源始终只保留官方段，不受 ALLOW_RELAY 影响；无 cfOnly 的反代源在 ALLOW_RELAY 默认时保留", async () => {
  const { collectCandidatesWithHealth } = await import("../scripts/lib/candidates.js");
  const bodies = {
    "https://a.example/cf.txt": "104.16.1.1:443\n43.161.228.229:443\n",
    "https://a.example/relay.txt": "150.230.206.130:443#JP\n",
  };
  const fetchImpl = async (url) => new Response(bodies[url] || "", { status: 200 });
  const remoteSources = [
    { name: "tg-source", url: "https://a.example/cf.txt", type: "text", cfOnly: true },
    { name: "cmliu-addressesapi", url: "https://a.example/relay.txt", type: "text" },
  ];
  const { candidates } = await collectCandidatesWithHealth({ remoteSources, fetchImpl, allowRelay: true });
  const addrs = candidates.map((c) => c.address);
  assert.ok(addrs.includes("104.16.1.1"));
  assert.ok(!addrs.includes("43.161.228.229"));
  assert.ok(addrs.includes("150.230.206.130"));
  const strict = await collectCandidatesWithHealth({ remoteSources, fetchImpl, allowRelay: false });
  assert.ok(!strict.candidates.map((c) => c.address).includes("150.230.206.130"));
});
