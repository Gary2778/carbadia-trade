// server/lifecycle.mjs:超时设置、SIGTERM 序列(停止 accept → hub.close(1012) → server.close → exit(0))、排空超时、二次信号、
// unhandledRejection 不退出、RSS 采样与告警、dispose。用真实 http.Server + 注入的假 process,不碰本进程的信号与退出。
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installLifecycle } from "../../../server/lifecycle.mjs";

function fakeProc(rssBytes = 100 * 1024 * 1024) {
  return Object.assign(new EventEmitter(), { exit: vi.fn<(code?: number) => void>(), memoryUsage: () => ({ rss: rssBytes }) });
}

function fakeHub() {
  const close = vi.fn<(code: number, reason: string) => Promise<void>>(async () => {});
  return { close };
}

async function listeningServer(): Promise<Server> {
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

const installed: { dispose(): void }[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const l of installed.splice(0)) l.dispose();
  for (const s of servers.splice(0)) s.close();
});

describe("installLifecycle", () => {
  it("设置 keepAliveTimeout 65 s、headersTimeout 66 s", async () => {
    const httpServer = await listeningServer();
    servers.push(httpServer);
    installed.push(installLifecycle({ httpServer, hub: null, log: () => {}, maxRssMb: 900, proc: fakeProc() }));
    expect(httpServer.keepAliveTimeout).toBe(65_000);
    expect(httpServer.headersTimeout).toBe(66_000);
  });

  it("SIGTERM:先 hub.close(1012),http server 关闭后 exit(0)", async () => {
    const httpServer = await listeningServer();
    const hub = fakeHub();
    const proc = fakeProc();
    const order: string[] = [];
    hub.close.mockImplementation(async () => {
      order.push("hub.close");
    });
    httpServer.on("close", () => order.push("server.closed"));
    installed.push(installLifecycle({ httpServer, hub, log: () => {}, maxRssMb: 900, proc }));

    proc.emit("SIGTERM");
    expect(hub.close).toHaveBeenCalledWith(1012, expect.any(String));
    expect(httpServer.listening).toBe(false); // 立即停止 accept
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
    expect(order).toEqual(["hub.close", "server.closed"]);
    expect(proc.exit).toHaveBeenCalledTimes(1);
  });

  it("没有 hub(WS_DISABLED)也能完成同一序列", async () => {
    const httpServer = await listeningServer();
    const proc = fakeProc();
    installed.push(installLifecycle({ httpServer, hub: null, log: () => {}, maxRssMb: 900, proc }));
    proc.emit("SIGINT");
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
  });

  it("排空超时:连接迟迟不结束也在 drainTimeoutMs 后 exit(0)", async () => {
    const proc = fakeProc();
    const log = vi.fn<(line: string) => void>();
    const stuck = { keepAliveTimeout: 0, headersTimeout: 0, close: vi.fn() } as unknown as Server; // close 永不回调
    installed.push(installLifecycle({ httpServer: stuck, hub: fakeHub(), log, maxRssMb: 900, proc, drainTimeoutMs: 20 }));
    proc.emit("SIGTERM");
    expect(proc.exit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
    expect(log.mock.calls.map(([l]) => l)).toContain("[lifecycle] drain timeout, exiting");
  });

  it("排空期间再来一次信号立即退出", () => {
    const proc = fakeProc();
    const stuck = { keepAliveTimeout: 0, headersTimeout: 0, close: vi.fn() } as unknown as Server;
    installed.push(installLifecycle({ httpServer: stuck, hub: fakeHub(), log: () => {}, maxRssMb: 900, proc, drainTimeoutMs: 60_000 }));
    proc.emit("SIGTERM");
    expect(proc.exit).not.toHaveBeenCalled();
    proc.emit("SIGINT");
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it("hub.close 失败只记日志,退出流程照走", async () => {
    const httpServer = await listeningServer();
    const proc = fakeProc();
    const log = vi.fn<(line: string) => void>();
    const hub = fakeHub();
    hub.close.mockRejectedValue(new Error("hub exploded"));
    installed.push(installLifecycle({ httpServer, hub, log, maxRssMb: 900, proc }));
    proc.emit("SIGTERM");
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
    expect(log.mock.calls.some(([l]) => l.includes("hub.close failed") && l.includes("hub exploded"))).toBe(true);
  });

  it("hub.close 同步抛异常也只记日志(不变成 uncaughtException),退出流程照走", async () => {
    const httpServer = await listeningServer();
    const proc = fakeProc();
    const log = vi.fn<(line: string) => void>();
    const hub = fakeHub();
    hub.close.mockImplementation(() => {
      throw new Error("sync boom");
    });
    installed.push(installLifecycle({ httpServer, hub, log, maxRssMb: 900, proc }));
    expect(() => proc.emit("SIGTERM")).not.toThrow();
    expect(hub.close).toHaveBeenCalledWith(1012, expect.any(String));
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
    expect(log.mock.calls.some(([l]) => l.includes("hub.close failed") && l.includes("sync boom"))).toBe(true);
  });

  it("hub.close 返回非 thenable 也不崩、不记失败", async () => {
    const httpServer = await listeningServer();
    const proc = fakeProc();
    const log = vi.fn<(line: string) => void>();
    const hub = fakeHub();
    hub.close.mockReturnValue(undefined as unknown as Promise<void>);
    installed.push(installLifecycle({ httpServer, hub, log, maxRssMb: 900, proc }));
    expect(() => proc.emit("SIGTERM")).not.toThrow();
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
    expect(log.mock.calls.some(([l]) => l.includes("hub.close failed"))).toBe(false);
  });

  it("unhandledRejection 记日志、不退出", () => {
    const proc = fakeProc();
    const log = vi.fn<(line: string) => void>();
    const server = { keepAliveTimeout: 0, headersTimeout: 0, close: vi.fn() } as unknown as Server;
    installed.push(installLifecycle({ httpServer: server, hub: null, log, maxRssMb: 900, proc }));
    proc.emit("unhandledRejection", new Error("late failure"));
    expect(proc.exit).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([l]) => l.includes("unhandledRejection") && l.includes("late failure"))).toBe(true);
  });

  it("按间隔记 RSS JSON 行;超过 maxRssMb 追加告警行", async () => {
    const proc = fakeProc(950 * 1024 * 1024);
    const log = vi.fn<(line: string) => void>();
    const server = { keepAliveTimeout: 0, headersTimeout: 0, close: vi.fn() } as unknown as Server;
    installed.push(installLifecycle({ httpServer: server, hub: null, log, maxRssMb: 900, proc, rssIntervalMs: 5 }));
    await vi.waitFor(() => expect(log.mock.calls.length).toBeGreaterThanOrEqual(2));
    const lines = log.mock.calls.map(([l]) => l);
    const json = lines.find((l) => l.startsWith("{"));
    expect(JSON.parse(json!)).toEqual({ src: "lifecycle", ev: "rss", rssMb: 950, maxRssMb: 900 });
    expect(lines).toContain("[lifecycle] warn: rss 950 MB exceeds MAX_RSS_MB 900");
  });

  it("未超限时只有 JSON 行,没有告警", async () => {
    const proc = fakeProc(100 * 1024 * 1024);
    const log = vi.fn<(line: string) => void>();
    const server = { keepAliveTimeout: 0, headersTimeout: 0, close: vi.fn() } as unknown as Server;
    installed.push(installLifecycle({ httpServer: server, hub: null, log, maxRssMb: 900, proc, rssIntervalMs: 5 }));
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    expect(log.mock.calls.every(([l]) => l.startsWith("{"))).toBe(true);
  });

  it("dispose 摘掉信号监听与采样定时器", () => {
    const proc = fakeProc();
    const server = { keepAliveTimeout: 0, headersTimeout: 0, close: vi.fn() } as unknown as Server;
    const lifecycle = installLifecycle({ httpServer: server, hub: null, log: () => {}, maxRssMb: 900, proc });
    expect(proc.listenerCount("SIGTERM")).toBe(1);
    expect(proc.listenerCount("SIGINT")).toBe(1);
    expect(proc.listenerCount("unhandledRejection")).toBe(1);
    lifecycle.dispose();
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("unhandledRejection")).toBe(0);
    proc.emit("SIGTERM");
    expect(proc.exit).not.toHaveBeenCalled();
  });
});
