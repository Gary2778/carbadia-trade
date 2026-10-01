#!/usr/bin/env node
// @ts-check
// 度量用的演示账号(P2-11):在一台本地服务上经 POST /api/auth/demo 建一个演示账号,把会话的 Cookie 头写进文件(0600),
// 再按 --profile 造一些账户活动。会改该服务的库,只对本地开发库或它的副本跑(非本地地址拒绝,除非 --allow-remote)。
// 演示账号每 IP 每小时 3 个(服务端内存限流,重启服务即清零)。
//
//   node scripts/perf/demo-account.mjs http://localhost:3982 --cookie-out <文件> --profile activity
//   node scripts/perf/demo-account.mjs http://localhost:3982 --cookie-out <文件> --profile heavy
//   node scripts/perf/demo-account.mjs http://localhost:3982 --cookie-out <文件>                     # 只登录(profile none)
//
// profile:
//   · activity(资产页 / 终端一致性、CSV 对照、缓存头、已登录 Lighthouse 用):前三个有最新价的非情景标的各市价买 30 吨;
//     第一个挂一张 3 倍市价的 SELL 限价单 4 吨(挂着,锁持仓)并挂一个 3 吨的场外挂牌(锁持仓);第二个注销 2 吨。
//     于是持仓行里有「挂单锁 4 + 场外锁 3」与「已注销 2」两种情形。
//   · heavy(大账本负载的准备):前两个标的各市价买 40 吨;之后停服务,用 scripts/perf/big-ledger.mjs 对库副本追加流水。
//   · none:只建账号、写 cookie。
// 输出一行 JSON:userId、各持仓(symbol、数量、锁定与其来源、已注销)。cookie 只写进文件,不打印。
// 退出码:0 成功;2 参数错误、非本地地址、请求失败(含演示账号限流 429)。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { isLocalBase, refuseRemoteMessage } from "./local-base.mjs";

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(`[demo-account] ${msg}`);
  process.exit(2);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = { base: "http://localhost:3982", cookieOut: "", profile: "none", allowRemote: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i] ?? die(`${a} needs a value`);
    if (a === "--cookie-out") o.cookieOut = value();
    else if (a === "--profile") o.profile = value();
    else if (a === "--allow-remote") o.allowRemote = true;
    else if (!a.startsWith("-")) o.base = a.replace(/\/+$/, "");
    else die(`unknown argument ${a}`);
  }
  if (!o.cookieOut) die("--cookie-out <file> is required (the session's Cookie header value is written there, mode 0600)");
  if (!["activity", "heavy", "none"].includes(o.profile)) die(`--profile must be activity, heavy or none, got ${o.profile}`);
  if (!isLocalBase(o.base) && !o.allowRemote) die(refuseRemoteMessage(o.base));
  return o;
}

const o = parseArgs(process.argv.slice(2));
let cookie = "";

/** @param {string} path @param {string} [method] @param {unknown} [body] @returns {Promise<any>} */
async function call(path, method = "GET", body) {
  const res = await fetch(o.base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const json = /** @type {any} */ (await res.json().catch(() => null));
  if (!json?.ok) die(`${method} ${path} → ${res.status} ${json?.error ?? "(no envelope)"}`);
  return json.data;
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await call("/api/auth/demo", "POST");
  if (!cookie) die("demo login did not set a session cookie");
  fs.writeFileSync(o.cookieOut, cookie, { mode: 0o600 });

  /** @type {{ id: string; symbol: string; isScenario: boolean; lastPrice: number | null; tickSize: number }[]} */
  const instruments = (await call("/api/market/instruments")).instruments.map((/** @type {any} */ i) => i.instrument);
  const priced = instruments.filter((i) => !i.isScenario && i.lastPrice != null);
  const buy = async (/** @type {{ id: string }} */ inst, /** @type {number} */ quantity) =>
    call("/api/orders", "POST", { assetId: inst.id, side: "BUY", type: "MARKET", quantity, clientOrderId: randomUUID() });

  if (o.profile === "activity") {
    if (priced.length < 3) die("need three non-scenario instruments with a last price");
    const [a, b, c] = priced;
    for (const inst of [a, b, c]) await buy(inst, 30);
    await sleep(800);
    const tick = Math.max(1, a.tickSize);
    const last = /** @type {number} */ (a.lastPrice);
    await call("/api/orders", "POST", { assetId: a.id, side: "SELL", type: "LIMIT", price: Math.ceil((last * 3) / tick) * tick, quantity: 4, clientOrderId: randomUUID() });
    await call("/api/otc", "POST", { assetId: a.id, quantity: 3, pricePerUnit: last * 2, minQuantity: 1 });
    await call("/api/retirements", "POST", {
      assetId: b.id,
      quantity: 2,
      reason: "Event Offset",
      beneficiary: "P2-11 check",
      purpose: "Overview vs positions",
      publicMessage: "",
      idempotencyKey: randomUUID(),
      acknowledged: true,
    });
  } else if (o.profile === "heavy") {
    if (priced.length < 2) die("need two non-scenario instruments with a last price");
    for (const inst of priced.slice(0, 2)) await buy(inst, 40);
    await sleep(500);
  }

  const me = await call("/api/auth/me");
  const positions = (await call("/api/account/positions")).positions;
  console.log(
    JSON.stringify({
      userId: me.id,
      profile: o.profile,
      cookieFile: o.cookieOut,
      positions: positions.map((/** @type {any} */ p) => ({ symbol: p.symbol, quantity: p.quantity, locked: p.locked, lockedBy: p.lockedBy ?? null, retired: p.retired })),
    }),
  );
}

main().catch((e) => die(e instanceof Error ? (e.stack ?? e.message) : String(e)));
