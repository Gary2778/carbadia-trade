// 流水分类(计划 §6.2.2 C4):activityOf 的分类与标签、type → 筛选条件的映射,以及两者必须一致的性质测试——
// 任意一行账本,activityOf 得到的 type 拿去筛选,一定能筛回这一行,且别的 type 都筛不到它(各 type 互不重叠、合起来不漏)。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { LedgerAccount as WriterAccount } from "./ledger";
import {
  ACTIVITY_TYPES,
  KNOWN_REASONS,
  LEDGER_ACCOUNTS,
  REASONS_BY_TYPE,
  activityFilter,
  activityOf,
  matchesActivityFilter,
  type ActivityType,
  type LedgerAccount,
} from "./ledger-activity";

/** 代码里会写入的 reason(简报「现状」一节)+ 只读不写的 MIGRATION_BASELINE */
const WRITTEN_REASONS = [
  "ORDER_LOCK", "ORDER_UNLOCK", "SELF_TRADE_UNLOCK", "TRADE_SETTLE", "PRICE_IMPROVE_REFUND", "OTC_LOCK", "OTC_UNLOCK", "OTC_SETTLE",
  "GRANT", "SEED", "BOT_MINT_CASH", "BOT_MINT_QTY", "SIMULATED_RETIREMENT", "MIGRATION_BASELINE",
];
/** ledger.test.ts「流水种类齐全」那条用例列的 reason */
const LEDGER_TEST_REASONS = ["GRANT", "SEED", "ORDER_LOCK", "ORDER_UNLOCK", "TRADE_SETTLE", "PRICE_IMPROVE_REFUND", "OTC_LOCK", "OTC_SETTLE", "OTC_UNLOCK", "SELF_TRADE_UNLOCK"];
/** 没有专门分类、落到 ADJUSTMENT 的 reason:机器人补铸(人类用户的账本里不会有),以及将来任何没登记的新 reason */
const UNCLASSIFIED_REASONS = ["BOT_MINT_CASH", "BOT_MINT_QTY"];

const typeOf = (account: string, reason: string, delta: number | bigint) => activityOf({ account, reason, delta }).type;
const labelOf = (account: string, reason: string, delta: number | bigint) => activityOf({ account, reason, delta }).label;

describe("共享类型", () => {
  it("LedgerAccount 与账本写入器的联合是同一个(src/shared 不能引 src/lib,所以各定义一次)", () => {
    expectTypeOf<LedgerAccount>().toEqualTypeOf<WriterAccount>();
  });

  it("ACTIVITY_TYPES / LEDGER_ACCOUNTS 穷尽各自的联合,没有重复", () => {
    expectTypeOf<(typeof ACTIVITY_TYPES)[number]>().toEqualTypeOf<ActivityType>();
    expectTypeOf<(typeof LEDGER_ACCOUNTS)[number]>().toEqualTypeOf<LedgerAccount>();
    expect(new Set(ACTIVITY_TYPES).size).toBe(ACTIVITY_TYPES.length);
    expect([...LEDGER_ACCOUNTS].sort()).toEqual(["CASH", "CASH_LOCKED", "HOLDING", "HOLDING_LOCKED"]);
    expect(Object.keys(REASONS_BY_TYPE).sort()).toEqual([...ACTIVITY_TYPES].sort());
  });
});

describe("activityOf:分类与标签(原 /api/transactions 的 activity(),文字一字不改)", () => {
  it("撮合成交:HOLDING 按正负分买卖,其余账户是结算腿", () => {
    expect(activityOf({ account: "HOLDING", reason: "TRADE_SETTLE", delta: 5 })).toEqual({ type: "BUY", label: "Credits purchased" });
    expect(activityOf({ account: "HOLDING", reason: "TRADE_SETTLE", delta: -5 })).toEqual({ type: "SELL", label: "Credits sold" });
    expect(activityOf({ account: "HOLDING_LOCKED", reason: "TRADE_SETTLE", delta: -5 })).toEqual({ type: "SETTLEMENT", label: "Reserved credits delivered" });
    expect(activityOf({ account: "CASH", reason: "TRADE_SETTLE", delta: 900 })).toEqual({ type: "SETTLEMENT", label: "Trade proceeds" });
    expect(activityOf({ account: "CASH", reason: "TRADE_SETTLE", delta: -900 })).toEqual({ type: "SETTLEMENT", label: "Trade payment" });
    expect(activityOf({ account: "CASH_LOCKED", reason: "TRADE_SETTLE", delta: -900 })).toEqual({ type: "SETTLEMENT", label: "Trade payment" });
  });

  it("OTC 成交:同一套规则,带 OTC 前缀", () => {
    expect(activityOf({ account: "HOLDING", reason: "OTC_SETTLE", delta: 5 })).toEqual({ type: "OTC_BUY", label: "OTC credits purchased" });
    expect(activityOf({ account: "HOLDING", reason: "OTC_SETTLE", delta: -5 })).toEqual({ type: "OTC_SELL", label: "OTC credits sold" });
    expect(activityOf({ account: "HOLDING_LOCKED", reason: "OTC_SETTLE", delta: -5 })).toEqual({ type: "OTC_SETTLEMENT", label: "Reserved OTC credits delivered" });
    expect(activityOf({ account: "CASH", reason: "OTC_SETTLE", delta: 900 })).toEqual({ type: "OTC_SETTLEMENT", label: "OTC proceeds" });
    expect(activityOf({ account: "CASH", reason: "OTC_SETTLE", delta: -900 })).toEqual({ type: "OTC_SETTLEMENT", label: "OTC payment" });
  });

  it("冻结 / 解冻:挂单与 OTC 同类,自成交防护的解冻标签点明原因", () => {
    for (const reason of ["ORDER_LOCK", "OTC_LOCK"]) {
      expect(activityOf({ account: "HOLDING_LOCKED", reason, delta: 3 })).toEqual({ type: "RESERVE", label: "Credits reserved" });
      expect(activityOf({ account: "CASH_LOCKED", reason, delta: 300 })).toEqual({ type: "RESERVE", label: "Demo funds reserved" });
      expect(activityOf({ account: "CASH", reason, delta: -300 })).toEqual({ type: "RESERVE", label: "Demo funds reserved" });
    }
    for (const reason of ["ORDER_UNLOCK", "OTC_UNLOCK"]) {
      expect(activityOf({ account: "HOLDING_LOCKED", reason, delta: -3 })).toEqual({ type: "RELEASE", label: "Credits released" });
      expect(activityOf({ account: "CASH", reason, delta: 300 })).toEqual({ type: "RELEASE", label: "Demo funds released" });
    }
    expect(activityOf({ account: "HOLDING_LOCKED", reason: "SELF_TRADE_UNLOCK", delta: -3 })).toEqual({ type: "RELEASE", label: "Credits released (self-trade prevention)" });
    expect(activityOf({ account: "CASH", reason: "SELF_TRADE_UNLOCK", delta: 300 })).toEqual({ type: "RELEASE", label: "Demo funds released (self-trade prevention)" });
  });

  it("注销、退款、赠金、期初余额", () => {
    expect(activityOf({ account: "HOLDING", reason: "SIMULATED_RETIREMENT", delta: -4 })).toEqual({ type: "RETIREMENT", label: "Simulated credit retirement" });
    expect(activityOf({ account: "CASH", reason: "PRICE_IMPROVE_REFUND", delta: 50 })).toEqual({ type: "REFUND", label: "Price improvement refund" });
    expect(activityOf({ account: "CASH", reason: "GRANT", delta: 10_000_000 })).toEqual({ type: "GRANT", label: "Demo funds granted" });
    expect(activityOf({ account: "HOLDING", reason: "GRANT", delta: 10 })).toEqual({ type: "GRANT", label: "Demo credits granted" });
    expect(activityOf({ account: "CASH", reason: "SEED", delta: 10_000_000 })).toEqual({ type: "OPENING_BALANCE", label: "Opening demo cash" });
    expect(activityOf({ account: "HOLDING", reason: "SEED", delta: 10 })).toEqual({ type: "OPENING_BALANCE", label: "Opening demo credits" });
    expect(activityOf({ account: "CASH", reason: "MIGRATION_BASELINE", delta: 10 })).toEqual({ type: "OPENING_BALANCE", label: "Opening ledger balance" });
    expect(activityOf({ account: "HOLDING", reason: "MIGRATION_BASELINE", delta: 10 })).toEqual({ type: "OPENING_BALANCE", label: "Opening ledger balance" });
  });

  it("没登记的 reason → ADJUSTMENT,标签是小写、下划线换空格的 reason", () => {
    expect(activityOf({ account: "CASH", reason: "BOT_MINT_CASH", delta: 1 })).toEqual({ type: "ADJUSTMENT", label: "bot mint cash" });
    expect(activityOf({ account: "HOLDING", reason: "BOT_MINT_QTY", delta: 1 })).toEqual({ type: "ADJUSTMENT", label: "bot mint qty" });
    expect(activityOf({ account: "CASH", reason: "SOMETHING_NEW", delta: -1 })).toEqual({ type: "ADJUSTMENT", label: "something new" });
  });

  it("delta 是 BigInt(Prisma 的 LedgerEntry.delta)或 number,结果相同", () => {
    for (const reason of WRITTEN_REASONS) {
      for (const account of LEDGER_ACCOUNTS) {
        for (const delta of [-7, 0, 7]) {
          expect(activityOf({ account, reason, delta: BigInt(delta) })).toEqual(activityOf({ account, reason, delta }));
        }
      }
    }
  });
});

describe("type → reason 集合(筛选用)", () => {
  it("REASONS_BY_TYPE 逐项", () => {
    expect(REASONS_BY_TYPE).toEqual({
      BUY: ["TRADE_SETTLE"],
      SELL: ["TRADE_SETTLE"],
      SETTLEMENT: ["TRADE_SETTLE"],
      OTC_BUY: ["OTC_SETTLE"],
      OTC_SELL: ["OTC_SETTLE"],
      OTC_SETTLEMENT: ["OTC_SETTLE"],
      RETIREMENT: ["SIMULATED_RETIREMENT"],
      RESERVE: ["ORDER_LOCK", "OTC_LOCK"],
      RELEASE: ["ORDER_UNLOCK", "OTC_UNLOCK", "SELF_TRADE_UNLOCK"],
      REFUND: ["PRICE_IMPROVE_REFUND"],
      GRANT: ["GRANT"],
      OPENING_BALANCE: ["SEED", "MIGRATION_BASELINE"],
      ADJUSTMENT: [],
    });
  });

  it("KNOWN_REASONS = 各 type 的 reason 之并;ledger.test.ts 列的 reason 全部在内,每个都恰好落在某个非 ADJUSTMENT 的 type 下", () => {
    expect([...KNOWN_REASONS].sort()).toEqual([...new Set(Object.values(REASONS_BY_TYPE).flat())].sort());
    for (const reason of [...LEDGER_TEST_REASONS, "SIMULATED_RETIREMENT", "MIGRATION_BASELINE"]) {
      expect(KNOWN_REASONS, reason).toContain(reason);
      const types = new Set(LEDGER_ACCOUNTS.flatMap((account) => [-1, 1].map((delta) => typeOf(account, reason, delta))));
      expect(types.has("ADJUSTMENT"), reason).toBe(false);
      for (const type of types) expect(REASONS_BY_TYPE[type], `${reason} → ${type}`).toContain(reason);
    }
    for (const reason of UNCLASSIFIED_REASONS) expect(KNOWN_REASONS, reason).not.toContain(reason);
  });

  it("activityFilter:买卖按 HOLDING 账户与正负区分,结算腿是 HOLDING 以外的账户,ADJUSTMENT 是「不在已知 reason 里」", () => {
    expect(activityFilter("BUY")).toEqual({ reasons: ["TRADE_SETTLE"], exclude: false, holding: true, positive: true });
    expect(activityFilter("SELL")).toEqual({ reasons: ["TRADE_SETTLE"], exclude: false, holding: true, positive: false });
    expect(activityFilter("SETTLEMENT")).toEqual({ reasons: ["TRADE_SETTLE"], exclude: false, holding: false, positive: null });
    expect(activityFilter("OTC_BUY")).toEqual({ reasons: ["OTC_SETTLE"], exclude: false, holding: true, positive: true });
    expect(activityFilter("OTC_SELL")).toEqual({ reasons: ["OTC_SETTLE"], exclude: false, holding: true, positive: false });
    expect(activityFilter("OTC_SETTLEMENT")).toEqual({ reasons: ["OTC_SETTLE"], exclude: false, holding: false, positive: null });
    expect(activityFilter("RELEASE")).toEqual({ reasons: ["ORDER_UNLOCK", "OTC_UNLOCK", "SELF_TRADE_UNLOCK"], exclude: false, holding: null, positive: null });
    expect(activityFilter("ADJUSTMENT")).toEqual({ reasons: KNOWN_REASONS, exclude: true, holding: null, positive: null });
  });
});

describe("性质:activityOf 的分类与筛选条件完全一致", () => {
  const reasons = [...WRITTEN_REASONS, "SOMETHING_NEW"];
  // 四个正式账户之外再放一个不存在的账户名:activityOf 对它也有定义(按「不是 HOLDING」处理),筛选条件必须跟上
  const accounts = [...LEDGER_ACCOUNTS, "UNKNOWN_ACCOUNT"];
  const deltas: (number | bigint)[] = [-5, 0, 5, BigInt(-5), BigInt(0), BigInt(5)];
  const cases = reasons.flatMap((reason) => accounts.flatMap((account) => deltas.map((delta) => ({ reason, account, delta }))));

  it("每个 reason × account × 正负 delta:用它自己的 type 筛得回来,用别的 type 都筛不到", () => {
    expect(cases.length).toBe(reasons.length * accounts.length * deltas.length);
    for (const entry of cases) {
      const own = activityOf(entry).type;
      const matched = ACTIVITY_TYPES.filter((type) => matchesActivityFilter(entry, activityFilter(type)));
      expect(matched, `${entry.reason} / ${entry.account} / ${entry.delta}`).toEqual([own]);
    }
  });

  it("每个 type 至少有一种组合落在它下面(没有筛不出任何东西的死类型)", () => {
    const seen = new Set(cases.map((entry) => activityOf(entry).type));
    expect([...seen].sort()).toEqual([...ACTIVITY_TYPES].sort());
  });

  it("标签:activityOf 从不返回空标签", () => {
    for (const entry of cases) expect(labelOf(entry.account, entry.reason, entry.delta).length).toBeGreaterThan(0);
  });
});

describe("账本写入处的 reason 字面量都登记过(启发式)", () => {
  const SRC = fileURLToPath(new URL("../..", import.meta.url));
  const ROOT = join(SRC, "..");

  /** 某个目录下的全部 .ts / .tsx(不含测试) */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  // 只扫写账本的文件:撮合、OTC、注销、机器人补铸、注册 / 演示账号的赠金、种子数据。
  // 别处出现的 reason: "X" 不是写入(例如 account-mappers.ts 里按 SELF_TRADE_UNLOCK 查流水的条件),不算进来。
  const LEDGER_WRITERS = [
    ...["matching.ts", "otc.ts", "retirement.ts", "bot.ts"].map((name) => join(SRC, "lib", "exchange", name)),
    ...sourceFiles(join(SRC, "app", "api", "auth")),
    join(ROOT, "prisma", "seed.ts"),
  ];

  // 这是启发式,不是证明:只认写在对象字面量里的 reason: "X"。reason 经变量或参数传进去的写法看不见——
  // 例如自成交防护的 SELF_TRADE_UNLOCK 是作为实参传给 releaseAndCancel 的,这里扫不到(它由上面的分类测试单独覆盖);
  // 以后新增的写入文件不在名单里时也扫不到。它能拦住的是:在这些文件里照现有写法新加一个 reason 字面量却忘了归类。
  it("写入文件里的 reason: \"X\" 字面量,要么有分类,要么在「落到 ADJUSTMENT」的名单里", () => {
    const found = new Set<string>();
    for (const file of LEDGER_WRITERS) {
      for (const m of readFileSync(file, "utf8").matchAll(/\breason:\s*"([A-Z][A-Z0-9_]+)"/g)) found.add(m[1]);
    }
    // 扫描确实命中了账本写入处(防止文件改名或正则失效后空扫描通过)
    for (const reason of ["ORDER_LOCK", "TRADE_SETTLE", "OTC_SETTLE", "GRANT", "SEED", "SIMULATED_RETIREMENT", "BOT_MINT_CASH"]) expect(found, reason).toContain(reason);
    const unregistered = [...found].filter((reason) => !KNOWN_REASONS.includes(reason) && !UNCLASSIFIED_REASONS.includes(reason));
    expect(unregistered, "新的账本 reason 要在 ledger-activity.ts 里归类(或明确列入 ADJUSTMENT 名单)").toEqual([]);
  });
});
