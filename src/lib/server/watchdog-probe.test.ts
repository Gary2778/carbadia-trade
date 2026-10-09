// 看门狗探针辅助(设计 §3.1):密钥定长比较、数据库目录推断、卷用量读数、写探针包装。不连库、不读 .env。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WATCHDOG_HEADER, compactErrorMessage, databaseDirectory, deepProbe, isWatchdogRequest, readDiskUsage } from "./watchdog-probe";

const req = (headers: Record<string, string> = {}) => new Request("http://localhost/api/health", { headers });

// 两个默认参数都读环境变量;钉成空串,结果与 shell / Docker 构建环境里的 WATCHDOG_SECRET、DATABASE_URL 无关
beforeEach(() => {
  vi.stubEnv("WATCHDOG_SECRET", "");
  vi.stubEnv("DATABASE_URL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("isWatchdogRequest", () => {
  it("头与密钥相同才算看门狗请求", () => {
    expect(isWatchdogRequest(req({ [WATCHDOG_HEADER]: "abc" }), "abc")).toBe(true);
  });
  it("不带头、头不同、长度不等、密钥未设或为空:一律不是", () => {
    expect(isWatchdogRequest(req(), "abc")).toBe(false);
    expect(isWatchdogRequest(req({ [WATCHDOG_HEADER]: "abd" }), "abc")).toBe(false);
    expect(isWatchdogRequest(req({ [WATCHDOG_HEADER]: "ab" }), "abc")).toBe(false);
    expect(isWatchdogRequest(req({ [WATCHDOG_HEADER]: "abc" }), undefined)).toBe(false);
    expect(isWatchdogRequest(req({ [WATCHDOG_HEADER]: "" }), "")).toBe(false);
  });
});

describe("databaseDirectory", () => {
  it("file: 绝对路径取所在目录,去掉查询串", () => {
    expect(databaseDirectory("file:/data/trade.db")).toBe("/data");
    expect(databaseDirectory("file:/data/trade.db?connection_limit=1")).toBe("/data");
  });
  it("相对路径或缺失:用进程工作目录(本地 dev 与生产卷在同一文件系统即可)", () => {
    expect(databaseDirectory("file:./dev.db")).toBe(process.cwd());
    expect(databaseDirectory(undefined)).toBe(process.cwd());
  });
});

describe("readDiskUsage", () => {
  it("对存在的目录返回三个整数,usedPct 在 0 到 100 之间", async () => {
    const disk = await readDiskUsage(process.cwd());
    expect(disk).not.toBeNull();
    expect(Number.isInteger(disk!.totalMb)).toBe(true);
    expect(Number.isInteger(disk!.freeMb)).toBe(true);
    expect(disk!.totalMb).toBeGreaterThan(0);
    expect(disk!.usedPct).toBeGreaterThanOrEqual(0);
    expect(disk!.usedPct).toBeLessThanOrEqual(100);
  });
  it("目录不存在返回 null,不抛", async () => {
    expect(await readDiskUsage("/no/such/dir/for/watchdog")).toBeNull();
  });
});

describe("deepProbe", () => {
  it("写入成功:write true,带 disk", async () => {
    const probe = await deepProbe(async () => 1);
    expect(probe.write).toBe(true);
    expect(probe.disk).not.toBeNull();
    expect("writeError" in probe).toBe(false);
  });
  it("写入抛错:write false,writeError 是压缩后的消息前 300 字符", async () => {
    const probe = await deepProbe(async () => { throw new Error(`SQLITE_FULL: database or disk is full ${"x".repeat(400)}`); });
    expect(probe.write).toBe(false);
    if (probe.write) throw new Error("unreachable");
    expect(probe.writeError.startsWith("SQLITE_FULL: database or disk is full")).toBe(true);
    expect(probe.writeError).toHaveLength(300);
  });
  it("Prisma 的错误消息:去掉「Invalid … invocation:」头、压掉换行,原因留在前面", () => {
    const prismaMessage = "\nInvalid `prisma.heartbeat.upsert()` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(SqliteError { extended_code: 13, message: Some(\"database or disk is full\") }), transient: false })";
    const compact = compactErrorMessage(new Error(prismaMessage));
    expect(compact.startsWith("Error occurred during query execution: ConnectorError(")).toBe(true);
    expect(compact).toContain("database or disk is full");
    expect(compact.length).toBeLessThanOrEqual(300);
  });
  it("写入抛非 Error 值也能转成字符串", async () => {
    const probe = await deepProbe(async () => { throw "boom"; });
    expect(probe).toMatchObject({ write: false, writeError: "boom" });
  });
});
