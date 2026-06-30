#!/usr/bin/env node
/**
 * 本地代理 SSE 流式透传测试
 *
 * 用法:
 *   node test-proxy.mjs                            # 默认 claude-sonnet-4-7
 *   node test-proxy.mjs claude-sonnet-4-6
 *   node test-proxy.mjs claude-sonnet-4-7 9000     # 指定端口
 *
 * 看点：
 *   1) 状态码 200，Content-Type 含 text/event-stream
 *   2) chunk 数 > 1（说明是流式，不是攒到末尾一次返回）
 *   3) 控制台能看到 event: content_block_delta 一段段实时打印
 *   4) 末尾出现 event: message_stop
 */

const model = process.argv[2] || "claude-sonnet-4-7";
const port = process.argv[3] || "8765";
const url = `http://127.0.0.1:${port}/v1/messages`;

const body = JSON.stringify({
  model,
  max_tokens: 256,
  stream: true,
  messages: [
    {
      role: "user",
      content: "你好，请用中文从 1 数到 8，每个数字单独一行，每行格式是「第 N 个」",
    },
  ],
});

console.log(`POST ${url}`);
console.log(`model = ${model}`);
console.log("---");

const t0 = Date.now();
let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "dummy-key-the-proxy-will-replace",
      "anthropic-version": "2023-06-01",
    },
    body,
  });
} catch (err) {
  console.error("[连接失败]", err.message);
  console.error("→ 检查代理是否在运行、端口是否正确");
  process.exit(1);
}

console.log(`HTTP ${res.status} ${res.statusText}`);
console.log(`Content-Type: ${res.headers.get("content-type")}`);
console.log("---");

if (!res.ok) {
  const text = await res.text();
  console.error("[非 2xx 响应]");
  console.error(text);
  process.exit(1);
}

if (!res.body) {
  console.error("[响应没有 body]");
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let chunkCount = 0;
let firstChunkAt = null;
let bytes = 0;
let buf = "";
let eventTypes = new Map();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  if (firstChunkAt === null) firstChunkAt = Date.now();
  chunkCount++;
  bytes += value.byteLength;

  const text = decoder.decode(value, { stream: true });
  process.stdout.write(text);

  // 统计事件类型
  buf += text;
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const m = line.match(/^event:\s*(\S+)/);
    if (m) eventTypes.set(m[1], (eventTypes.get(m[1]) || 0) + 1);
  }
}

const total = Date.now() - t0;
const ttfb = firstChunkAt - t0;

console.log("\n---");
console.log(`chunks   : ${chunkCount}`);
console.log(`bytes    : ${bytes}`);
console.log(`TTFB     : ${ttfb} ms`);
console.log(`total    : ${total} ms`);
console.log(`events   :`, Object.fromEntries(eventTypes));

if (chunkCount <= 1) {
  console.log(
    "\n⚠️  只收到 1 个 chunk —— 上游可能没开启 stream，或代理在缓冲（请检查）"
  );
} else {
  console.log("\n✅ 收到多个 chunk，SSE 流式透传工作正常");
}
