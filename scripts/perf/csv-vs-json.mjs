#!/usr/bin/env node
// @ts-check
// CSV 导出的行数 = 同筛选 JSON 翻到底的行数(计划 §6.2「Phase 2 验收标准」;P2-11)。只读:只发 GET,不改库。
// 对着已经在跑的服务、用一个账号的会话运行(--cookie-file 里是 Cookie 请求头的值,一行,如 cx_session=…):
//
//   node scripts/perf/csv-vs-json.mjs http://localhost:3982 --cookie-file <文件> --kind ledger [--query "account=HOLDING"]
//   node scripts/perf/csv-vs-json.mjs http://localhost:3982 --cookie-file <文件> --kind orders --query "status=history"
//   node scripts/perf/csv-vs-json.mjs http://localhost:3982 --cookie-file <文件> --kind fills  --query "symbol=CCER-SOL-2022"
//   选项:--page-size N(JSON 每页条数,默认 100)
//
// kind:ledger = /api/transactions ↔ /api/transactions.csv;orders = /api/account/orders ↔ /api/account/orders.csv;
//       fills = /api/account/fills ↔ /api/account/fills.csv。JSON 按 nextCursor 翻到底收集 id,CSV 按 RFC 4180 切记录
//       (引号里的换行不算行尾)。有 id 列时(流水)再逐 id 比对顺序;委托与成交的 CSV 没有 id 列,只比行数。
// 另报:CSV 是否以 UTF-8 BOM 开头、environment 列是否全是 SIMULATED、导出耗时。
// 输出一行 JSON;exit 0 = 行数相等(有 id 列时还要逐 id 同序)且 CSV 是 200,1 = 不等,2 = 参数或请求错误。
// 注意 CSV 每用户每分钟 10 次(429):连着跑多组时每组之间隔几秒。
import fs from "node:fs";
import process from "node:process";

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(`[csv-vs-json] ${msg}`);
  process.exit(2);
}

/** @type {Record<string, { json: string; csv: string; key: string }>} */
const KINDS = {
  ledger: { json: "/api/transactions", csv: "/api/transactions.csv", key: "items" },
  orders: { json: "/api/account/orders", csv: "/api/account/orders.csv", key: "orders" },
  fills: { json: "/api/account/fills", csv: "/api/account/fills.csv", key: "fills" },
};

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = { base: "http://localhost:3982", cookie: "", kind: "", query: "", pageSize: 100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i] ?? die(`${a} needs a value`);
    if (a === "--cookie-file") {
      const file = value();
      try {
        o.cookie = fs.readFileSync(file, "utf8").trim();
      } catch {
        die(`--cookie-file ${file} is not readable`);
      }
    } else if (a === "--kind") o.kind = value();
    else if (a === "--query") o.query = value().replace(/^\?/, "");
    else if (a === "--page-size") o.pageSize = Number(value());
    else if (!a.startsWith("-")) o.base = a.replace(/\/+$/, "");
    else die(`unknown argument ${a}`);
  }
  if (!o.cookie) die("--cookie-file is required (one line: the Cookie header value)");
  if (!KINDS[o.kind]) die(`--kind must be one of ${Object.keys(KINDS).join(" / ")}, got ${o.kind || "(none)"}`);
  if (!Number.isInteger(o.pageSize) || o.pageSize < 1) die(`--page-size must be a positive integer`);
  return o;
}

/** RFC 4180 切记录(引号里的逗号与换行属于字段) @param {string} text @returns {string[][]} */
function parseCsv(text) {
  /** @type {string[][]} */
  const records = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") continue;
    else if (ch === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    records.push(row);
  }
  return records;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const conf = KINDS[o.kind];
  const init = { headers: { Cookie: o.cookie } };

  /** @type {string[]} */
  const ids = [];
  /** @type {string | null} */
  let cursor = null;
  let pages = 0;
  do {
    const params = new URLSearchParams(o.query);
    params.set("limit", String(o.pageSize));
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${o.base}${conf.json}?${params}`, init);
    const body = /** @type {any} */ (await res.json().catch(() => null));
    if (!body?.ok) die(`GET ${conf.json} → ${res.status} ${body?.error ?? "(no envelope)"}`);
    ids.push(...body.data[conf.key].map((/** @type {{ id: string }} */ r) => r.id));
    cursor = body.data.nextCursor ?? null;
    pages++;
  } while (cursor);

  const started = performance.now();
  const res = await fetch(`${o.base}${conf.csv}${o.query ? `?${o.query}` : ""}`, init);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const csvMs = Math.round(performance.now() - started);
  if (res.status !== 200) die(`GET ${conf.csv} → ${res.status} ${new TextDecoder().decode(bytes).slice(0, 200)}`);
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).replace(/^﻿/, "");
  const [header = [], ...rows] = parseCsv(text);
  const idCol = header.indexOf("id");
  const csvIds = idCol >= 0 ? rows.map((r) => r[idCol]) : null;
  const sameIdsInOrder = csvIds ? csvIds.length === ids.length && csvIds.every((id, i) => id === ids[i]) : null;
  const envCol = header.indexOf("environment");
  const equal = rows.length === ids.length;
  const summary = {
    kind: o.kind,
    query: o.query || "(none)",
    status: res.status,
    jsonRows: ids.length,
    jsonPages: pages,
    csvRows: rows.length,
    equal,
    sameIdsInOrder,
    bom,
    environmentAllSimulated: envCol >= 0 ? rows.every((r) => r[envCol] === "SIMULATED") : null,
    csvMs,
  };
  console.log(JSON.stringify(summary));
  process.exit(equal && sameIdsInOrder !== false ? 0 : 1);
}

main().catch((e) => die(e instanceof Error ? (e.stack ?? e.message) : String(e)));
