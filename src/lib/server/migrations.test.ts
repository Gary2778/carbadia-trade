// 迁移可重放门禁:Prisma 不把迁移包在事务里,中途停下后 docker-entrypoint.sh 会删掉未完成记录、重放整份迁移。
// 条件单与通知这份迁移只建表建索引,每条都必须带 IF NOT EXISTS,重放时已生效的那几条才不会报「已存在」(静态扫描,不连库)。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION = fileURLToPath(new URL("../../../prisma/migrations/20261002000000_triggers_notifications/migration.sql", import.meta.url));

/** 去掉 -- 注释行后按分号切出语句(这份迁移的语句里没有字符串里的分号) */
function statements(sql: string): string[] {
  const body = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return body
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

describe("20261002000000_triggers_notifications 可重放", () => {
  const list = statements(readFileSync(MIGRATION, "utf8"));

  it("九条语句:两条 CREATE TABLE、七条 CREATE [UNIQUE] INDEX,没有别的语句", () => {
    expect(list).toHaveLength(9);
    expect(list.filter((s) => /^CREATE TABLE /.test(s))).toHaveLength(2);
    expect(list.filter((s) => /^CREATE (UNIQUE )?INDEX /.test(s))).toHaveLength(7);
  });

  it("每一条都带 IF NOT EXISTS", () => {
    const missing = list.filter((s) => !/^CREATE (TABLE|(UNIQUE )?INDEX) IF NOT EXISTS "/.test(s));
    expect(missing).toEqual([]);
  });
});

const HEARTBEAT = fileURLToPath(new URL("../../../prisma/migrations/20261009000000_heartbeat/migration.sql", import.meta.url));

describe("20261009000000_heartbeat 可重放", () => {
  const list = statements(readFileSync(HEARTBEAT, "utf8"));

  it("只有一条语句:CREATE TABLE IF NOT EXISTS \"Heartbeat\"", () => {
    expect(list).toHaveLength(1);
    expect(list[0]).toMatch(/^CREATE TABLE IF NOT EXISTS "Heartbeat" \(/);
  });
});
