// 资产页与终端持仓页签的数字一致(计划 §6.2「Phase 2 验收标准」;P2-11)。只读:只发 GET,不改库。
// 资产页读 GET /api/account/overview(服务端用 computeAccountTotals 算好的 totals);终端持仓页签读 GET /api/account/positions
// 的持仓行 + GET /api/auth/me 的余额,在客户端用同一个 computeAccountTotals 按价格重算(src/lib/market/account-view.ts)。
// 这里对同一账号取两边,终端一侧按 `(p) => p.lastPrice` 重算(与服务端同一个价格入口;界面上换成行情最新价时两边一起变),
// 比对持仓行、余额与 totals 的每一项。两次总览之间价格变了就重取(最多 5 次),避免把行情走动当成不一致。
//
//   npx tsx scripts/perf/account-consistency.mts http://localhost:3982 --cookie-file <文件>
//
// --cookie-file 里是 Cookie 请求头的值(一行,如 cx_session=…)。输出一行 JSON;
// exit 0 = 持仓行逐字节相同、余额相等、totals 全等;1 = 有差异;2 = 参数或请求错误、5 次都没取到稳定的一组。
import fs from "node:fs";
import process from "node:process";
import { computeAccountTotals } from "../../src/shared/account-totals";
import type { AccountOverview, PositionsResponse } from "../../src/shared/api-shapes";
import type { Me } from "../../src/shared/types";

function die(msg: string): never {
  console.error(`[account-consistency] ${msg}`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const o = { base: "http://localhost:3982", cookie: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cookie-file") {
      const file = argv[++i] ?? die("--cookie-file needs a value");
      try {
        o.cookie = fs.readFileSync(file, "utf8").trim();
      } catch {
        die(`--cookie-file ${file} is not readable`);
      }
    } else if (!a.startsWith("-")) o.base = a.replace(/\/+$/, "");
    else die(`unknown argument ${a}`);
  }
  if (!o.cookie) die("--cookie-file is required (one line: the Cookie header value)");
  return o;
}

const o = parseArgs(process.argv.slice(2));

async function get<T>(path: string): Promise<T> {
  const res = await fetch(o.base + path, { headers: { Cookie: o.cookie } });
  const body = (await res.json().catch(() => null)) as { ok: true; data: T } | { ok: false; error: string } | null;
  if (!body?.ok) die(`GET ${path} → ${res.status} ${body && !body.ok ? body.error : "(no envelope)"}`);
  return body.data;
}

async function main() {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const before = await get<AccountOverview>("/api/account/overview");
    const positions = await get<PositionsResponse>("/api/account/positions");
    const me = await get<Me>("/api/auth/me");
    const after = await get<AccountOverview>("/api/account/overview");
    if (!me) die("/api/auth/me returned no user (is the cookie valid for this server?)");
    const stable = JSON.stringify(before.positions) === JSON.stringify(after.positions) && JSON.stringify(before.balance) === JSON.stringify(after.balance);
    if (!stable) {
      console.error(`[account-consistency] attempt ${attempt}: prices or balance moved between the two overview reads, retrying`);
      continue;
    }
    const balance = { cashBalance: me.cashBalance, lockedCash: me.lockedCash };
    const terminal = computeAccountTotals(balance, positions.positions, (p) => p.lastPrice);
    const keys = Object.keys(before.totals) as (keyof typeof before.totals)[];
    const differingKeys = keys.filter((k) => before.totals[k] !== terminal[k]);
    const positionRowsIdentical = JSON.stringify(before.positions) === JSON.stringify(positions.positions);
    // 余额:终端的账户 store 取 /api/auth/me;/api/account/positions 也带一份 balance,一并比对
    const balanceEqual =
      before.balance.cashBalance === balance.cashBalance &&
      before.balance.lockedCash === balance.lockedCash &&
      (!positions.balance || (positions.balance.cashBalance === balance.cashBalance && positions.balance.lockedCash === balance.lockedCash));
    console.log(
      JSON.stringify({
        attempt,
        rows: positions.positions.length,
        positionRowsIdentical,
        balanceEqual,
        differingKeys,
        overviewTotals: before.totals,
        terminalTotals: terminal,
        change24h: before.change24h,
        otcListings: before.otcListings.length,
      }),
    );
    process.exit(positionRowsIdentical && balanceEqual && differingKeys.length === 0 ? 0 : 1);
  }
  die("no stable pair of overview reads in 5 attempts (market moving too fast?)");
}

main().catch((e: unknown) => die(e instanceof Error ? (e.stack ?? e.message) : String(e)));
