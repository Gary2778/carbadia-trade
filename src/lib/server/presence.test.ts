// presence.ts(计划 §3.4 两级门控的第二级):读 globalThis.__carbadiaPresence 的计数;ticker:* 通配;没有 hub 时一律 false。
import { afterEach, describe, expect, it } from "vitest";
import type { Presence } from "@/shared/bus";
import { hasInterest, hasUser } from "./presence";

function setPresence(topics: Record<string, number> = {}, users: Record<string, number> = {}) {
  const presence: Presence = { users: new Map(Object.entries(users)), topics: new Map() };
  for (const [topic, n] of Object.entries(topics)) presence.topics.set(topic as Parameters<typeof hasInterest>[0], n);
  globalThis.__carbadiaPresence = presence;
  return presence;
}

afterEach(() => {
  globalThis.__carbadiaPresence = undefined;
});

describe("hasInterest", () => {
  it("没有 hub(__carbadiaPresence 不存在)→ 任何 topic 都无兴趣", () => {
    expect(hasInterest("book:VCS-FOR-2021")).toBe(false);
    expect(hasInterest("ticker:*")).toBe(false);
    expect(hasInterest("account")).toBe(false);
  });

  it("计数 > 0 才算有兴趣;增减后立即反映(同一份 Map,不缓存)", () => {
    const presence = setPresence({ "book:VCS-FOR-2021": 1 });
    expect(hasInterest("book:VCS-FOR-2021")).toBe(true);
    expect(hasInterest("book:GS-WIND-2022")).toBe(false);
    expect(hasInterest("trades:VCS-FOR-2021")).toBe(false);
    presence.topics.set("book:VCS-FOR-2021", 0);
    expect(hasInterest("book:VCS-FOR-2021")).toBe(false);
    presence.topics.set("candles:VCS-FOR-2021:1m", 2);
    expect(hasInterest("candles:VCS-FOR-2021:1m")).toBe(true);
    expect(hasInterest("candles:VCS-FOR-2021:5m")).toBe(false);
  });

  it("ticker:* 有订阅 → 所有 ticker:SYM 都有兴趣;对 book / trades / candles 不通配", () => {
    setPresence({ "ticker:*": 1 });
    expect(hasInterest("ticker:VCS-FOR-2021")).toBe(true);
    expect(hasInterest("ticker:ANY")).toBe(true);
    expect(hasInterest("ticker:*")).toBe(true);
    expect(hasInterest("book:VCS-FOR-2021")).toBe(false);
    expect(hasInterest("trades:VCS-FOR-2021")).toBe(false);
    expect(hasInterest("candles:VCS-FOR-2021:1m")).toBe(false);
  });

  it("只订了 ticker:SYM 时 ticker:* 本身无兴趣", () => {
    setPresence({ "ticker:VCS-FOR-2021": 1 });
    expect(hasInterest("ticker:VCS-FOR-2021")).toBe(true);
    expect(hasInterest("ticker:*")).toBe(false);
    expect(hasInterest("ticker:GS-WIND-2022")).toBe(false);
  });
});

describe("hasUser", () => {
  it("users 计数 > 0 才算在线;没有 hub 时 false", () => {
    expect(hasUser("u1")).toBe(false);
    const presence = setPresence({}, { u1: 2 });
    expect(hasUser("u1")).toBe(true);
    expect(hasUser("u2")).toBe(false);
    presence.users.set("u1", 0);
    expect(hasUser("u1")).toBe(false);
  });
});
