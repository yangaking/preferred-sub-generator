import { textResponse } from "../utils/response.js";

const SOURCE = "https://api.4ce.cn/api/bestCFIP";
const BACKUP_KEY = "VVHAN_LAST";
const CARRIERS = ["CT", "CU", "CM"];

function formatItems(json) {
  if (json.success !== true || !Array.isArray(json.data?.items)) throw new Error("Invalid vvHan response");
  const lines = [];
  const seen = new Set();
  for (const carrier of CARRIERS) {
    for (const item of json.data.items) {
      if (item?.line !== carrier) continue;
      const ip = String(item.ip || "").trim();
      const parts = ip.split(".");
      if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) || seen.has(ip)) continue;
      seen.add(ip);
      const delay = item.latency == null || item.latency === "" ? NaN : Number(item.latency);
      const suffix = Number.isFinite(delay) && delay >= 0 ? `-${Math.round(delay)}ms` : "";
      lines.push(`${ip}:443#vvHan-${carrier}${suffix}`);
    }
  }
  if (!lines.length) throw new Error("No valid vvHan IPv4 addresses");
  return lines.join("\n") + "\n";
}

function output(text, source, status = 200) {
  const response = textResponse(text);
  response.headers.set("Cache-Control", status === 200 ? "public, max-age=300" : "no-store");
  response.headers.set("X-Vvhan-Source", source);
  return new Response(response.body, { status, headers: response.headers });
}

export async function handleVvhan(env, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(SOURCE, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!response.ok) throw new Error(`vvHan HTTP ${response.status}`);
    const text = formatItems(await response.json());
    // 只在内容变化时写入；KV 故障不影响本次有效的上游结果。
    try {
      if (env.SUB_KV && await env.SUB_KV.get(BACKUP_KEY) !== text) {
        await env.SUB_KV.put(BACKUP_KEY, text);
      }
    } catch (error) {
      console.log(`vvHan backup skipped: ${error.message}`);
    }
    return output(text, "live");
  } catch (error) {
    console.log(`vvHan fetch failed: ${error.message}`);
    let backup = null;
    try {
      backup = await env.SUB_KV?.get(BACKUP_KEY);
    } catch {
      // 上游和 KV 都不可用时返回 503，不把报错文本当作 IP 列表。
    }
    return backup ? output(backup, "backup") : output("vvHan temporarily unavailable\n", "unavailable", 503);
  }
}
