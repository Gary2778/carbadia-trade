// server/ws-hub.mjs 的 attachWsHub 用真实 http.createServer + ws 客户端测(计划 §3.3 鉴权与 upgrade 路由、连接上限、关闭码):
// hello → subscribe → 快照 → 总线 delta;trades since 回放;cookie 验签;Origin 403;总连接 503 + Retry-After;每 IP 上限与共享桶豁免;
// 非 /ws 的 upgrade 被 destroy 且服务仍活;畸形请求目标(`//`、absolute-form、超长、坏编码)不抛、不留孤儿 socket;被拒的 upgrade 写完即 destroy;
// 打桩 bufferedAmount → resync;close(1012) 广播;WS_DISABLED。
// 这里没有 Next:请求处理器只把 /api/health 回 200,upgrade 路由的行为与 server.mjs 里完全一样(同一个 attachWsHub)。
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createBus } from "../../../server/bus.mjs";
import { DEV_SESSION_SECRET, resolveSessionSecret, signSession } from "../../../server/session.mjs";
import { DEFAULT_MAX_UNTRUSTED, attachWsHub } from "../../../server/ws-hub.mjs";
import { serverFrameSchema } from "../../../server/ws-schema.mjs";
import type { BusMessage } from "@/shared/bus";
import type { TapeEntry } from "@/shared/types";
import type { ClientOp, ServerEvent } from "@/shared/ws-protocol";

type AttachOpts = Parameters<typeof attachWsHub>[1];

const running: { server: Server; hub: ReturnType<typeof attachWsHub> }[] = [];
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const { server, hub } of running.splice(0)) {
    await hub.close(1001, "test over");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  globalThis.__carbadiaWsStats = undefined;
});

async function start(opts: Partial<AttachOpts> = {}) {
  const bus = createBus();
  const server = createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true,"data":{"db":true}}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const hub = attachWsHub(server, { bus, log: () => {}, batchMs: 5, backpressureScanMs: 10, isKnownSymbol: (s) => s !== "NOPE", ...opts });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  running.push({ server, hub });
  return { bus, hub, server, port, url: `ws://127.0.0.1:${port}/ws` };
}

type Client = {
  ws: WebSocket;
  events: ServerEvent[];
  closed: Promise<{ code: number; reason: string }>;
  send(op: ClientOp): void;
  until<T extends ServerEvent["t"]>(t: T, n?: number): Promise<Extract<ServerEvent, { t: T }>[]>;
  of<T extends ServerEvent["t"]>(t: T): Extract<ServerEvent, { t: T }>[];
};

function connect(url: string, options: WebSocket.ClientOptions = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    clients.push(ws);
    const events: ServerEvent[] = [];
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })));
    ws.on("message", (data) => {
      const frame = serverFrameSchema.parse(JSON.parse(data.toString()));
      events.push(...(frame as ServerEvent[]));
    });
    ws.on("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode, headers: res.headers })));
    ws.on("error", reject);
    const of = <T extends ServerEvent["t"]>(t: T) => events.filter((e): e is Extract<ServerEvent, { t: T }> => e.t === t);
    ws.on("open", () =>
      resolve({
        ws,
        events,
        closed,
        send: (op) => ws.send(JSON.stringify(op)),
        of,
        until: async (t, n = 1) => {
          await vi.waitFor(() => expect(of(t).length).toBeGreaterThanOrEqual(n), { timeout: 2_000 });
          return of(t);
        },
      }),
    );
  });
}

/** 期望握手被服务端以 HTTP 状态拒绝 */
async function expectRejected(url: string, options: WebSocket.ClientOptions = {}) {
  try {
    await connect(url, options);
  } catch (err) {
    return err as Error & { statusCode?: number; headers?: IncomingMessage["headers"] };
  }
  throw new Error("expected the upgrade to be rejected");
}

function health(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/health", method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

function bookDelta(symbol: string): BusMessage {
  const ts = 1_700_000_000_000;
  return {
    kind: "book",
    symbol,
    snapshot: { symbol, bids: [{ price: 6_800, quantity: 10, orders: 1 }], asks: [], ts },
    delta: { symbol, bids: [{ price: 6_800, quantity: 10, orders: 1 }], asks: [], ts },
  };
}
/** 发布器的整份快照(delta null):首次 / 刷新时发,hub 推 book.snapshot */
function bookFull(symbol: string): BusMessage {
  const ts = 1_700_000_000_000;
  return { kind: "book", symbol, snapshot: { symbol, bids: [{ price: 6_800, quantity: 10, orders: 1 }], asks: [], ts }, delta: null };
}
function trade(symbol: string, i: number): TapeEntry {
  return { id: `t${i}`, symbol, price: 6_800 + i, quantity: 1, takerSide: "SELL", ts: 1_700_000_000_000 + i, auditRef: `SIM-TRD-t${i}` };
}

describe("attachWsHub · 协议往返", () => {
  it("hello → subscribe book:X → subscribed(hub 没有这本簿:请发布器刷新)→ 刷新的整份快照 → 总线发布 → book.delta seq+1", async () => {
    const refreshed: string[] = [];
    const { url, bus, hub } = await start({ bookRefresh: (symbol) => void refreshed.push(symbol) });
    const c = await connect(url);
    const [hello] = await c.until("hello");
    expect(hello).toMatchObject({ v: 1, heartbeatMs: 25_000, userId: null, maxTopics: 64 });
    c.send({ op: "subscribe", topics: ["book:X"] });
    await c.until("subscribed");
    expect(c.of("subscribed")[0]).toEqual({ t: "subscribed", topic: "book:X", seq: 0 });
    expect(refreshed).toEqual(["X"]);
    bus.publish(bookFull("X")); // 发布器刷新发来的整份快照
    const [snap] = await c.until("book.snapshot");
    expect(snap).toMatchObject({ topic: "book:X", seq: 1, symbol: "X", bids: [{ price: 6_800, quantity: 10, orders: 1 }], asks: [] });
    bus.publish(bookDelta("X"));
    const [delta] = await c.until("book.delta");
    expect(delta).toMatchObject({ topic: "book:X", seq: 2, symbol: "X", bids: [{ price: 6_800, quantity: 10, orders: 1 }] });
    expect(globalThis.__carbadiaTopicSeq?.get("book:X")).toBe(2);
    expect(hub.stats()).toMatchObject({ enabled: true, connections: 1, subscriptions: 1 });
    expect(globalThis.__carbadiaWsStats).toBe(hub.stats());
  });

  it("trades since 回放:缺口内逐条回放,各带原 seq", async () => {
    const { url, bus } = await start();
    for (let i = 1; i <= 3; i += 1) bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", i)] });
    const c = await connect(url);
    await c.until("hello");
    c.send({ op: "subscribe", topics: ["trades:X"], since: { "trades:X": 1 } });
    const replayed = await c.until("trades", 2);
    expect(c.of("subscribed")[0]).toEqual({ t: "subscribed", topic: "trades:X", seq: 1 });
    expect(replayed.map((e) => [e.seq, e.trades[0].id])).toEqual([
      [2, "t2"],
      [3, "t3"],
    ]);
  });

  it("ping → pong 带回 t0", async () => {
    const { url } = await start();
    const c = await connect(url);
    c.send({ op: "ping", t0: 42 });
    const [pong] = await c.until("pong");
    expect(pong).toEqual({ t: "pong", t0: 42, serverTime: expect.any(Number) });
  });
});

describe("attachWsHub · 鉴权", () => {
  it("匿名连接订阅 account → error unauthorized", async () => {
    const { url } = await start({ secret: "s3cret" });
    const c = await connect(url);
    c.send({ op: "subscribe", topics: ["account"] });
    const [err] = await c.until("error");
    expect(err).toEqual({ t: "error", code: "unauthorized", message: expect.any(String), topic: "account" });
  });

  it("带合法 cx_session cookie → hello.userId;签名不对 → 匿名(不拒绝连接)", async () => {
    const { url } = await start({ secret: "s3cret" });
    const good = await connect(url, { headers: { cookie: `other=1; cx_session=${encodeURIComponent(signSession("user_42", "s3cret"))}` } });
    expect((await good.until("hello"))[0].userId).toBe("user_42");
    const forged = await connect(url, { headers: { cookie: `cx_session=${signSession("user_42", "wrong")}` } });
    expect((await forged.until("hello"))[0].userId).toBeNull();
  });

  it("生产环境的 SESSION_SECRET 是公开的开发默认值:与 auth.ts 一样拒用(fail closed)——hub 照常启动,但全部连接按匿名处理、account 回 unauthorized,并记一行错误(终审 P1-25a)", async () => {
    // server.mjs 把 resolveSessionSecret() 传给 hub:生产下缺失或等于 DEV_SESSION_SECRET 都给 undefined(修复前原样给出开发默认值,
    // 用它伪造的 `<userId>.<hmac(dev)>` cookie 在 /ws 上能读到那个用户的余额、挂单、持仓与成交,REST 那边却全部拒绝)
    expect(resolveSessionSecret({ NODE_ENV: "production", SESSION_SECRET: DEV_SESSION_SECRET })).toBeUndefined();
    expect(resolveSessionSecret({ NODE_ENV: "production" })).toBeUndefined();
    expect(resolveSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "real-secret" })).toBe("real-secret");
    expect(resolveSessionSecret({ NODE_ENV: "development" })).toBe(DEV_SESSION_SECRET);
    const lines: string[] = [];
    const { url } = await start({ secret: resolveSessionSecret({ NODE_ENV: "production", SESSION_SECRET: DEV_SESSION_SECRET }), log: (line) => lines.push(line) });
    expect(lines.filter((l) => l.includes("[ws] error") && l.includes("SESSION_SECRET"))).toHaveLength(1);
    const forged = await connect(url, { headers: { cookie: `cx_session=${encodeURIComponent(signSession("user_42", DEV_SESSION_SECRET))}` } });
    expect((await forged.until("hello"))[0].userId).toBeNull();
    forged.send({ op: "subscribe", topics: ["account"] });
    expect((await forged.until("error"))[0]).toMatchObject({ code: "unauthorized", topic: "account" });
  });

  it("Origin 不在名单 → HTTP 403 不升级;名单内与无 Origin 都放行", async () => {
    const { url, hub } = await start({ allowedOrigins: ["https://cbda.trade", "http://localhost:*"] });
    const rejected = await expectRejected(url, { origin: "https://evil.example" });
    expect(rejected.statusCode).toBe(403);
    expect(hub.stats().rejected).toBe(1);
    await connect(url, { origin: "https://cbda.trade" });
    await connect(url, { origin: "http://localhost:3940" });
    await connect(url);
    expect(hub.stats().connections).toBe(3);
  });
});

describe("attachWsHub · 连接上限", () => {
  it("第 maxConnections+1 个连接 → 503 且 Retry-After: 30,rejected++", async () => {
    const { url, hub } = await start({ maxConnections: 2 });
    await connect(url);
    await connect(url);
    const rejected = await expectRejected(url);
    expect(rejected.statusCode).toBe(503);
    expect(rejected.headers?.["retry-after"]).toBe("30");
    expect(hub.stats()).toMatchObject({ connections: 2, rejected: 1 });
  });

  it("maxPerIp=2:可信 IP 的第 3 个 → 503,另一个可信 IP 不受影响;关闭后名额释放", async () => {
    const { url, hub } = await start({ maxPerIp: 2, proxySecret: "proxy-secret" });
    const trusted = { headers: { "x-proxy-secret": "proxy-secret", "cf-connecting-ip": "203.0.113.7" } };
    await connect(url, trusted);
    await connect(url, trusted);
    const rejected = await expectRejected(url, trusted);
    expect(rejected.statusCode).toBe(503);
    await connect(url, { headers: { "x-proxy-secret": "proxy-secret", "cf-connecting-ip": "203.0.113.8" } });
    expect(hub.stats()).toMatchObject({ connections: 3, rejected: 1 });
    clients[0].close(1000);
    await vi.waitFor(() => expect(hub.stats().connections).toBe(2));
    await connect(url, trusted);
  });

  it("\"untrusted\" 桶(直连源站、x-proxy-secret 不匹配)有自己的上限 maxUntrusted:第 maxUntrusted+1 个 → 503,可信 IP 照常接受(终审 P1-25a)", async () => {
    // 修复前:"untrusted" 豁免每 IP 上限,一台主机直连源站就能占满全部 500 个名额,所有真实访客的 /ws 都回 503
    const { url, hub } = await start({ maxPerIp: 8, maxUntrusted: 2, proxySecret: "proxy-secret" });
    // 伪造的 cf-connecting-ip 与错的 x-proxy-secret 都换不到新桶
    await connect(url, { headers: { "cf-connecting-ip": "198.51.100.1" } });
    await connect(url, { headers: { "cf-connecting-ip": "198.51.100.2", "x-proxy-secret": "guess" } });
    const rejected = await expectRejected(url, { headers: { "cf-connecting-ip": "198.51.100.3" } });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.headers?.["retry-after"]).toBe("30");
    await connect(url, { headers: { "x-proxy-secret": "proxy-secret", "cf-connecting-ip": "203.0.113.7" } });
    expect(hub.stats()).toMatchObject({ connections: 3, rejected: 1 });
    clients[0].close(1000); // 名额随连接关闭释放
    await vi.waitFor(() => expect(hub.stats().connections).toBe(2));
    await connect(url);
  });

  it("maxUntrusted 默认 16(代码内默认,不需要新的 Railway 变量)", async () => {
    expect(DEFAULT_MAX_UNTRUSTED).toBe(16);
    const { url } = await start({ proxySecret: "proxy-secret", maxConnections: 100 });
    for (let i = 0; i < 16; i += 1) await connect(url);
    expect((await expectRejected(url)).statusCode).toBe(503);
  });

  it("没配 PROXY_SECRET 的本地开发(\"local\" 桶):超过 maxPerIp 与 maxUntrusted 也照常接受(ws-flood 从本机开 300 个连接靠它)", async () => {
    const { url, hub } = await start({ maxPerIp: 1, maxUntrusted: 2 });
    for (let i = 0; i < 40; i += 1) await connect(url);
    expect(hub.stats()).toMatchObject({ connections: 40, rejected: 0 });
  });
});

describe("attachWsHub · upgrade 路由", () => {
  it("生产模式:非 /ws 的 upgrade 被 destroy(不写响应、不挂起),服务端不崩,/api/health 仍 200", async () => {
    const { port } = await start();
    expect(await health(port)).toBe(200);
    const outcome = await new Promise<{ data: string; ended: boolean }>((resolve) => {
      const socket = netConnect(port, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => (data += chunk.toString()));
      socket.on("close", () => resolve({ data, ended: true }));
      socket.on("error", () => {});
      socket.on("connect", () => socket.write("GET /api/assets HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
      setTimeout(() => {
        socket.destroy();
        resolve({ data, ended: false });
      }, 1_500);
    });
    expect(outcome).toEqual({ data: "", ended: true });
    expect(await health(port)).toBe(200);
  });

  it("dev 模式:非 /ws 的 upgrade 转交 nextUpgrade(HMR)", async () => {
    const nextUpgrade = vi.fn<(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void>((_req, socket) => socket.destroy());
    const { port, url } = await start({ dev: true, nextUpgrade });
    await new Promise<void>((resolve) => {
      const socket = netConnect(port, "127.0.0.1");
      socket.on("close", () => resolve());
      socket.on("error", () => {});
      socket.on("connect", () => socket.write("GET /_next/webpack-hmr HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
    });
    expect(nextUpgrade).toHaveBeenCalledTimes(1);
    expect(nextUpgrade.mock.calls[0][0].url).toBe("/_next/webpack-hmr");
    await connect(url); // /ws 仍归 hub
    expect(nextUpgrade).toHaveBeenCalledTimes(1);
  });

  it("disabled(WS_DISABLED=1):/ws 也被 destroy,__carbadiaWsStats 为 enabled: false 的零计数", async () => {
    const { url } = await start({ disabled: true });
    await expect(connect(url)).rejects.toThrow();
    expect(globalThis.__carbadiaWsStats).toEqual({
      enabled: false,
      connections: 0,
      subscriptions: 0,
      framesOut: 0,
      bytesOut: 0,
      droppedDeltas: 0,
      resyncs: 0,
      rejected: 0,
      closedByBackpressure: 0,
      snapshotRaces: 0,
      startedAt: expect.any(Number),
    });
  });

  it("超过 maxPayload(4096)的帧由 ws 以 1009 关闭", async () => {
    const { url } = await start();
    const c = await connect(url);
    await c.until("hello");
    c.ws.send("x".repeat(5_000));
    expect((await c.closed).code).toBe(1009);
  });
});

/**
 * 裸 TCP 发一个 upgrade 请求,收集服务端写回的字节;服务端关掉(end / close)即返回,超时则自己关掉并报 closedByServer: false。
 * halfOpen:客户端收到 FIN 后不回 FIN(allowHalfOpen,模拟不收尾的客户端),连接只能由服务端 destroy 掉。
 */
function rawUpgrade(port: number, target: string, { headers = [] as string[], halfOpen = false, timeoutMs = 1_500 } = {}) {
  return new Promise<{ data: string; closedByServer: boolean }>((resolve) => {
    const socket = netConnect({ port, host: "127.0.0.1", allowHalfOpen: halfOpen });
    let data = "";
    let settled = false;
    const done = (closedByServer: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ data, closedByServer });
      if (!halfOpen) socket.destroy();
    };
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => done(true));
    socket.on("close", () => done(true));
    socket.on("error", () => {});
    socket.on("connect", () =>
      socket.write(
        [`GET ${target} HTTP/1.1`, "Host: localhost", "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", ...headers, "", ""].join("\r\n"),
      ),
    );
    const timer = setTimeout(() => done(false), timeoutMs);
    halfOpenSockets.push(socket);
  });
}
const halfOpenSockets: import("node:net").Socket[] = [];
afterEach(() => {
  for (const s of halfOpenSockets.splice(0)) s.destroy();
});

function connectionsOf(server: Server): Promise<number> {
  return new Promise((resolve, reject) => server.getConnections((err, n) => (err ? reject(err) : resolve(n))));
}

describe("attachWsHub · 不可信的 upgrade 输入(终审 P1-25a)", () => {
  // 修复前:routeOther 用 WHATWG URL 解析请求目标,`//`、`///`、`//[`、`//:99999` 让 new URL 抛 ERR_INVALID_URL,
  // 从 'upgrade' 监听器里逃出去(裸进程即崩溃;server.mjs 下被 Next 的 uncaughtException 监听器吞掉,但 socket 成了孤儿,永不释放)
  const MALFORMED = ["//", "///", "//[", "//:99999", "http://evil/", "http://evil/ws", `/${"a".repeat(8_000)}`, "/ws%zz", "/%E0%A4%A", "/w%73"];

  it.each([false, true])("畸形 / 非 /ws 的请求目标:直接 destroy,不写一个字节、不抛 uncaughtException,连接数回到 0,/api/health 仍 200(disabled=%s)", async (disabled) => {
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    try {
      const { port, server } = await start({ disabled });
      for (const target of MALFORMED) {
        const outcome = await rawUpgrade(port, target);
        expect({ target, ...outcome }).toEqual({ target, data: "", closedByServer: true });
      }
      await vi.waitFor(async () => expect(await connectionsOf(server)).toBe(0), { timeout: 2_000 });
      expect(await health(port)).toBe(200);
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off("uncaughtException", uncaught);
    }
  });

  it("/ws 带查询串照常升级;absolute-form 的 http://host/ws 不算 /ws", async () => {
    const { port } = await start();
    const ok = await rawUpgrade(port, "/ws?probe=1", { timeoutMs: 300 });
    expect(ok.data.startsWith("HTTP/1.1 101")).toBe(true);
    const absolute = await rawUpgrade(port, "http://evil/ws");
    expect(absolute).toEqual({ data: "", closedByServer: true });
  });

  it("升级监听器里任何意外抛错都只 destroy 这条 socket、记一行日志,不外泄成 uncaughtException", async () => {
    const lines: string[] = [];
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    try {
      // dev 转交的 HMR 处理器同步抛错:与 Next 自己的 upgrade 处理器对坏请求抛错同形
      const { port, server } = await start({ dev: true, log: (line) => lines.push(line), nextUpgrade: () => {
        throw new Error("boom");
      } });
      const outcome = await rawUpgrade(port, "/_next/webpack-hmr");
      expect(outcome).toEqual({ data: "", closedByServer: true });
      await vi.waitFor(async () => expect(await connectionsOf(server)).toBe(0), { timeout: 2_000 });
      expect(uncaught).not.toHaveBeenCalled();
      expect(lines.some((l) => l.includes("[ws] upgrade handler failed") && l.includes("boom"))).toBe(true);
    } finally {
      process.off("uncaughtException", uncaught);
    }
  });

  it("被拒的 upgrade(403 / 503)写完响应即 destroy:不回 FIN 的半开客户端不再占着服务端 socket", async () => {
    const { port, server, url } = await start({ allowedOrigins: ["https://cbda.trade"], maxConnections: 1 });
    const forbidden = await rawUpgrade(port, "/ws", { headers: ["Origin: https://evil.example"], halfOpen: true });
    expect(forbidden.data.startsWith("HTTP/1.1 403 Forbidden\r\n")).toBe(true);
    expect(forbidden.closedByServer).toBe(true);
    await connect(url); // 占满唯一的名额
    const busy = await rawUpgrade(port, "/ws", { halfOpen: true });
    expect(busy.data).toMatch(/^HTTP\/1\.1 503 Service Unavailable\r\n[\s\S]*Retry-After: 30\r\n/);
    // 只剩那条真的 WebSocket 连接(修复前:两条半开的被拒 socket 一直算在 getConnections 里)
    await vi.waitFor(async () => expect(await connectionsOf(server)).toBe(1), { timeout: 2_000 });
  });
});

describe("attachWsHub · 背压与关闭", () => {
  it("打桩 bufferedAmount:>256 KB 跳 delta、降下来后收到 resync{backpressure}", async () => {
    let buffered = 0;
    const { url, bus, hub } = await start({ bufferedAmountOf: () => buffered });
    const c = await connect(url);
    c.send({ op: "subscribe", topics: ["book:X"] });
    await c.until("subscribed");
    bus.publish(bookFull("X"));
    await c.until("book.snapshot");
    buffered = 300 * 1024;
    bus.publish(bookDelta("X"));
    expect(hub.stats().droppedDeltas).toBe(1); // 跳过是同步的,不用等
    buffered = 0;
    const [resync] = await c.until("resync");
    expect(resync).toEqual({ t: "resync", topic: "book:X", reason: "backpressure" });
    expect(c.of("book.delta")).toHaveLength(0); // 帧按序到达:resync 之前没有 delta,之后也不会补来
    expect(hub.stats().resyncs).toBe(1);
  });

  it("唯一订阅者照 ws-client 的做法回应 resync(unsubscribe + subscribe 两帧紧挨着发):缓存不淘汰、不再请刷新,直接拿到整份快照", async () => {
    let buffered = 0;
    const refreshed: string[] = [];
    // 合帧窗口取生产默认的 50 ms:两帧经真实 socket 到达,落在同一窗口里
    const { url, bus } = await start({ batchMs: 50, bufferedAmountOf: () => buffered, bookRefresh: (symbol) => void refreshed.push(symbol) });
    const c = await connect(url);
    c.send({ op: "subscribe", topics: ["book:X"] });
    await c.until("subscribed");
    bus.publish(bookFull("X"));
    await c.until("book.snapshot");
    buffered = 300 * 1024;
    bus.publish(bookDelta("X")); // 跳过,topic 记 stale
    buffered = 0;
    await c.until("resync");
    c.send({ op: "unsubscribe", topics: ["book:X"] });
    c.send({ op: "subscribe", topics: ["book:X"] });
    const snaps = await c.until("book.snapshot", 2);
    expect(snaps[1]).toMatchObject({ topic: "book:X", seq: 2, bids: [{ price: 6_800, quantity: 10, orders: 1 }] });
    expect(refreshed).toEqual(["X"]); // 只有第一次订阅那一次(修复前:退订即淘汰,重订阅又请一次、等发布器回来)
  });

  it("订阅库里没有的 symbol 的盘口(标的缓存未填时放行):刷新钩子回 found: false 之后不再请,十个冷却期过去仍只一次", async () => {
    const refreshed: string[] = [];
    const bookRefresh = async (symbol: string) => {
      refreshed.push(symbol);
      return { found: false };
    };
    const { url } = await start({ isKnownSymbol: () => true, bookRefreshCooldownMs: 20, bookRefresh });
    const c = await connect(url);
    c.send({ op: "subscribe", topics: ["book:GHOST"] });
    await c.until("subscribed");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(refreshed).toEqual(["GHOST"]);
    expect(c.of("book.snapshot")).toHaveLength(0);
  });

  it("hub.close(1012) 后所有客户端收到 1012,close 在 2 s 内 resolve", async () => {
    const { url, hub } = await start();
    const a = await connect(url);
    const b = await connect(url);
    await a.until("hello");
    await b.until("hello");
    const started = Date.now();
    await hub.close(1012, "server restarting");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await a.closed).toEqual({ code: 1012, reason: "server restarting" });
    expect(await b.closed).toEqual({ code: 1012, reason: "server restarting" });
    expect(hub.stats().connections).toBe(0);
    await expect(connect(url)).rejects.toThrow(); // 关闭后不再接新连接
  });
});
