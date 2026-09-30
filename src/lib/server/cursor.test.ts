// 键集分页游标(计划 §3.4):base64url JSON 往返、非法值 → null、?cursor=&limit= 的解析规则。
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, readPageQuery } from "./cursor";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("encodeCursor / decodeCursor", () => {
  it("往返: 只带 createdAt 与 id 两个字段, 输出是 base64url(无 + / =)", () => {
    const encoded = encodeCursor({ createdAt: 1_758_844_800_123, id: "cmg1abc" });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual({ createdAt: 1_758_844_800_123, id: "cmg1abc" });
    expect(decodeCursor(encoded)).toEqual({ createdAt: 1_758_844_800_123, id: "cmg1abc" });
    expect(decodeCursor(encodeCursor({ createdAt: 0, id: "x" }))).toEqual({ createdAt: 0, id: "x" });
    expect(decodeCursor(encodeCursor({ createdAt: 8.64e15, id: "x" }))).toEqual({ createdAt: 8.64e15, id: "x" }); // Date 上界本身合法
  });

  it.each([
    ["空串", ""],
    ["不是 JSON", b64("not json")],
    ["随便的字符", "!!!not-base64!!!"],
    ["JSON 数组", b64("[1,2]")],
    ["JSON 标量", b64("42")],
    ["缺 id", b64(JSON.stringify({ createdAt: 1 }))],
    ["缺 createdAt", b64(JSON.stringify({ id: "a" }))],
    ["createdAt 是字符串", b64(JSON.stringify({ createdAt: "1", id: "a" }))],
    ["createdAt 小数", b64(JSON.stringify({ createdAt: 1.5, id: "a" }))],
    ["createdAt 负数", b64(JSON.stringify({ createdAt: -1, id: "a" }))],
    ["createdAt 超出安全整数", b64(JSON.stringify({ createdAt: 9_007_199_254_740_993, id: "a" }))],
    // 安全整数但超出 Date 范围(8.64e15):new Date() 是 Invalid Date,Prisma 抛校验错 → 路由 500(P1-25b)
    ["createdAt 超出 Date 范围", b64(JSON.stringify({ createdAt: 9_000_000_000_000_000, id: "x" }))],
    ["createdAt = 8.64e15 + 1", b64(JSON.stringify({ createdAt: 8_640_000_000_000_001, id: "x" }))],
    ["id 是数字", b64(JSON.stringify({ createdAt: 1, id: 7 }))],
    ["id 空串", b64(JSON.stringify({ createdAt: 1, id: "" }))],
    ["过长", "A".repeat(513)],
  ])("非法值 → null: %s", (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
});

describe("readPageQuery", () => {
  const q = (s: string) => readPageQuery(new URLSearchParams(s));

  it("缺省 limit 50、cursor null; limit 夹到 1..100", () => {
    expect(q("")).toEqual({ limit: 50, cursor: null });
    expect(q("limit=25")).toEqual({ limit: 25, cursor: null });
    expect(q("limit=0")).toEqual({ limit: 1, cursor: null });
    expect(q("limit=-3")).toEqual({ limit: 1, cursor: null });
    expect(q("limit=1000")).toEqual({ limit: 100, cursor: null });
    expect(q("limit=7.9")).toEqual({ limit: 7, cursor: null });
    expect(q("limit=")).toEqual({ limit: 50, cursor: null });
  });

  it("limit 非数字 → error; cursor 非法 → error; 合法 cursor 原样解出", () => {
    expect(q("limit=abc")).toEqual({ error: "Invalid limit" });
    expect(q("limit=NaN")).toEqual({ error: "Invalid limit" });
    expect(q("cursor=garbage")).toEqual({ error: "Invalid cursor" });
    const cursor = encodeCursor({ createdAt: 1_700_000_000_000, id: "ord_9" });
    expect(q(`cursor=${cursor}&limit=10`)).toEqual({ limit: 10, cursor: { createdAt: 1_700_000_000_000, id: "ord_9" } });
    expect(q("cursor=")).toEqual({ limit: 50, cursor: null });
  });
});
