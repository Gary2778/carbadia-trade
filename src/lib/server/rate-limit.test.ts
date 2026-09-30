import { describe, expect, it } from "vitest";
import { IP_BUCKET_LOCAL, IP_BUCKET_UNTRUSTED, clientIpFromHeaders, isSharedIpBucket } from "../../../server/client-ip.mjs";
import { clientIp, rateLimit, retryAfterSeconds } from "./rate-limit";

describe("rateLimit", () => {
  it("窗口内放行至 limit 次,超出拒绝", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(rateLimit("k1", 5, 60_000, t0 + i)).toBe(true);
    expect(rateLimit("k1", 5, 60_000, t0 + 10)).toBe(false);
  });
  it("窗口滑动后重新放行", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 3; i++) rateLimit("k2", 3, 1_000, t0);
    expect(rateLimit("k2", 3, 1_000, t0 + 500)).toBe(false);
    expect(rateLimit("k2", 3, 1_000, t0 + 1_001)).toBe(true);
  });
  it("key 之间互不影响", () => {
    const t0 = 3_000_000;
    rateLimit("a", 1, 1_000, t0);
    expect(rateLimit("b", 1, 1_000, t0)).toBe(true);
  });
});

describe("retryAfterSeconds(429 的 Retry-After)", () => {
  it("= 窗口内最早一次命中过期还需的秒数,向上取整", () => {
    const t0 = 4_000_000;
    for (const dt of [0, 20_000, 40_000]) expect(rateLimit("ra1", 3, 60_000, t0 + dt)).toBe(true);
    expect(rateLimit("ra1", 3, 60_000, t0 + 45_000)).toBe(false);
    expect(retryAfterSeconds("ra1", 60_000, t0 + 45_000)).toBe(15); // t0 的命中在 t0 + 60 s 过期
    expect(retryAfterSeconds("ra1", 60_000, t0 + 59_500)).toBe(1); // 0.5 s 向上取整
    expect(retryAfterSeconds("ra1", 60_000, t0 + 59_001)).toBe(1);
  });
  it("最早的命中滑出窗口后按下一次命中算", () => {
    const t0 = 5_000_000;
    for (const dt of [0, 20_000, 40_000]) rateLimit("ra2", 3, 60_000, t0 + dt);
    expect(retryAfterSeconds("ra2", 60_000, t0 + 61_000)).toBe(19); // t0 + 20 s 的命中在 t0 + 80 s 过期
  });
  it("至少 1 秒;没见过的 key 也返回 1", () => {
    expect(retryAfterSeconds("never-seen", 60_000, 6_000_000)).toBe(1);
    const t0 = 7_000_000;
    rateLimit("ra3", 1, 1_000, t0);
    expect(retryAfterSeconds("ra3", 1_000, t0 + 5_000)).toBe(1); // 窗口内已无命中
  });
  it("与 rateLimit 一致:等够 Retry-After 秒后确实放行", () => {
    const t0 = 8_000_000;
    for (let i = 0; i < 2; i++) rateLimit("ra4", 2, 10_000, t0 + i * 1_000);
    const denyAt = t0 + 3_500;
    expect(rateLimit("ra4", 2, 10_000, denyAt)).toBe(false);
    const wait = retryAfterSeconds("ra4", 10_000, denyAt);
    expect(wait).toBe(7);
    expect(rateLimit("ra4", 2, 10_000, denyAt + (wait - 1) * 1_000)).toBe(false);
    expect(rateLimit("ra4", 2, 10_000, denyAt + wait * 1_000)).toBe(true);
  });
});

describe("clientIpFromHeaders(单一来源:rate-limit 与 ws-hub 共用)", () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name] ?? null;

  it.each<{ name: string; secret: string | undefined; h: Record<string, string>; want: string }>([
    { name: "无 PROXY_SECRET、无 IP 头 → local", secret: undefined, h: {}, want: "local" },
    { name: "无 PROXY_SECRET、有 cf-connecting-ip → 直接信任(本地 / 灰度前部署)", secret: undefined, h: { "cf-connecting-ip": "5.6.7.8" }, want: "5.6.7.8" },
    { name: "无 PROXY_SECRET、只有 xff → 末跳", secret: undefined, h: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" }, want: "10.0.0.1" },
    {
      name: "有 PROXY_SECRET 且 x-proxy-secret 匹配 → cf-connecting-ip 优先于 xff",
      secret: "s3cret-value",
      h: { "x-proxy-secret": "s3cret-value", "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
      want: "9.9.9.9",
    },
    { name: "有 PROXY_SECRET 但缺 x-proxy-secret(直连)→ untrusted,无视伪造的 cf-connecting-ip", secret: "s3cret-value", h: { "cf-connecting-ip": "1.2.3.4" }, want: "untrusted" },
    { name: "有 PROXY_SECRET 但 x-proxy-secret 不匹配 → untrusted", secret: "s3cret-value", h: { "x-proxy-secret": "wrong", "cf-connecting-ip": "1.2.3.4" }, want: "untrusted" },
  ])("$name", ({ secret, h, want }) => {
    expect(clientIpFromHeaders(headers(h), secret)).toBe(want);
  });

  it("匹配密钥、无 cf 头时取 xff 末跳;xff 里的空段被忽略;无任何 IP 头回 local", () => {
    expect(clientIpFromHeaders(headers({ "x-proxy-secret": "s", "x-forwarded-for": "1.2.3.4,, 10.0.0.1 ," }), "s")).toBe("10.0.0.1");
    expect(clientIpFromHeaders(headers({ "x-proxy-secret": "s", "cf-connecting-ip": "  " }), "s")).toBe("local");
  });

  it("密钥比较不受长度前缀影响", () => {
    expect(clientIpFromHeaders(headers({ "x-proxy-secret": "s3cret-valu", "cf-connecting-ip": "1.2.3.4" }), "s3cret-value")).toBe("untrusted");
    expect(clientIpFromHeaders(headers({ "x-proxy-secret": "s3cret-value!", "cf-connecting-ip": "1.2.3.4" }), "s3cret-value")).toBe("untrusted");
  });

  it("untrusted / local 是共享桶(hub 对它们豁免每 IP 上限),真实 IP 不是", () => {
    expect(IP_BUCKET_UNTRUSTED).toBe("untrusted");
    expect(IP_BUCKET_LOCAL).toBe("local");
    expect(isSharedIpBucket("untrusted")).toBe(true);
    expect(isSharedIpBucket("local")).toBe(true);
    expect(isSharedIpBucket("1.2.3.4")).toBe(false);
  });
});

describe("clientIp(req) 是 clientIpFromHeaders 的薄包装", () => {
  it("取 x-forwarded-for 最后一个 IP(离服务器最近的代理追加,非客户端可伪造)", () => {
    const req = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } });
    expect(clientIp(req)).toBe("10.0.0.1");
  });
  it("cf-connecting-ip 优先于 x-forwarded-for", () => {
    const req = new Request("http://x", {
      headers: { "cf-connecting-ip": "5.6.7.8", "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
    });
    expect(clientIp(req)).toBe("5.6.7.8");
  });
  it("无头时回退 local", () => {
    expect(clientIp(new Request("http://x"))).toBe("local");
  });
});

describe("clientIp(req) — 代理密钥信任门(防直连伪造),经 process.env.PROXY_SECRET", () => {
  function withProxySecret<T>(value: string | undefined, fn: () => T): T {
    const prev = process.env.PROXY_SECRET;
    if (value === undefined) delete process.env.PROXY_SECRET;
    else process.env.PROXY_SECRET = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.PROXY_SECRET;
      else process.env.PROXY_SECRET = prev;
    }
  }

  it("设了 PROXY_SECRET 且 x-proxy-secret 匹配时,信任 cf-connecting-ip", () => {
    withProxySecret("s3cret-value", () => {
      const req = new Request("http://x", {
        headers: { "x-proxy-secret": "s3cret-value", "cf-connecting-ip": "9.9.9.9" },
      });
      expect(clientIp(req)).toBe("9.9.9.9");
    });
  });

  it("设了 PROXY_SECRET 但缺少 x-proxy-secret(直连)时,无视伪造的 cf-connecting-ip,返回 untrusted", () => {
    withProxySecret("s3cret-value", () => {
      const req = new Request("http://x", { headers: { "cf-connecting-ip": "1.2.3.4" } });
      expect(clientIp(req)).toBe("untrusted");
    });
  });

  it("设了 PROXY_SECRET 但 x-proxy-secret 不匹配时,返回 untrusted", () => {
    withProxySecret("s3cret-value", () => {
      const req = new Request("http://x", {
        headers: { "x-proxy-secret": "wrong", "cf-connecting-ip": "1.2.3.4" },
      });
      expect(clientIp(req)).toBe("untrusted");
    });
  });

  it("未设 PROXY_SECRET 时沿用旧行为(信任 cf-connecting-ip,不破坏本地/灰度前部署)", () => {
    withProxySecret(undefined, () => {
      const req = new Request("http://x", { headers: { "cf-connecting-ip": "5.6.7.8" } });
      expect(clientIp(req)).toBe("5.6.7.8");
    });
  });

  it("与 clientIpFromHeaders 逐字一致(同一函数,不是两份实现)", () => {
    withProxySecret("s3cret-value", () => {
      const req = new Request("http://x", { headers: { "x-proxy-secret": "s3cret-value", "x-forwarded-for": "1.1.1.1, 2.2.2.2" } });
      expect(clientIp(req)).toBe(clientIpFromHeaders((n) => req.headers.get(n), "s3cret-value"));
      expect(clientIp(req)).toBe("2.2.2.2");
    });
  });
});
