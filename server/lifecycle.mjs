// @ts-check
// 进程生命周期(计划 §3.4 契约表):优雅停机、排空超时、RSS 观测。纯 JS、无模块级状态,只由 server.mjs 调用一次。
// SIGTERM / SIGINT:停止 accept(httpServer.close 立即关掉监听 socket,同时开始排空既有连接)→ hub.close(1012) 向全部
// WebSocket 广播「服务重启」(客户端等 2–5 s 再退避重连)→ 连接排空后 exit(0),最多等 3 s(Railway 的停机宽限有限,
// 长连接不能拖住进程);排空期间再来一次信号立即退出。
// unhandledRejection 只记日志不退出(机器人 / 影子同步的偶发失败不该放倒整个站)。uncaughtException 这里不挂监听,但进程**不会**因它退出:
// server.mjs 的 app.prepare() 构造 NextNodeServer 时,Next 16 自己挂了一个只记日志的 uncaughtException 监听
//(installProcessErrorHandlers;dev 同理),所以同步抛错不会「崩溃后由平台重启」。维持这一行为(终审 P1-25a 复核):
// 我们的代码不依赖崩溃自愈——hub 的 upgrade / message 监听器自己兜住抛错并关掉那条 socket,不让它变成 uncaughtException。
// keepAliveTimeout 65 s / headersTimeout 66 s:大于 Railway 代理的 60 s 空闲,避免代理复用一条源站刚关掉的连接而得到 502。
// 每 30 s 打一行 {"src":"lifecycle","ev":"rss",...} JSON 日志;超过 maxRssMb 只告警,不主动退出(内存上限交给平台)。
import process from "node:process";

const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const HEADERS_TIMEOUT_MS = 66_000;
/** WebSocket 1012 Service Restart */
const RESTART_CLOSE_CODE = 1012;
const SIGNALS = /** @type {const} */ (["SIGTERM", "SIGINT"]);

/**
 * @typedef {object} LifecycleProcess 本模块用到的 process 子集;测试注入假对象
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} off
 * @property {(code?: number) => void} exit
 * @property {() => { rss: number }} memoryUsage
 */

/** @param {unknown} err */
function describe(err) {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * @param {object} opts
 * @param {import("node:http").Server} opts.httpServer
 * @param {{ close(code: number, reason: string): Promise<void> } | null} opts.hub 无 hub(WS_DISABLED)时传 null
 * @param {(line: string) => void} opts.log
 * @param {number} opts.maxRssMb 超过只告警
 * @param {LifecycleProcess} [opts.proc] 默认 process;测试注入
 * @param {number} [opts.drainTimeoutMs] 排空上限,默认 3000
 * @param {number} [opts.rssIntervalMs] RSS 采样间隔,默认 30000
 * @returns {{ shutdown(signal: string): void; dispose(): void }} dispose 摘掉监听与定时器(测试与热重载用)
 */
export function installLifecycle({ httpServer, hub, log, maxRssMb, proc = process, drainTimeoutMs = 3_000, rssIntervalMs = 30_000 }) {
  httpServer.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  httpServer.headersTimeout = HEADERS_TIMEOUT_MS;

  let shuttingDown = false;

  /** @param {string} signal */
  function shutdown(signal) {
    if (shuttingDown) {
      log(`[lifecycle] ${signal} received again, exiting now`);
      proc.exit(0);
      return;
    }
    shuttingDown = true;
    log(`[lifecycle] ${signal}: stop accepting, closing websockets (${RESTART_CLOSE_CODE}), draining http (<= ${drainTimeoutMs} ms)`);
    const deadline = setTimeout(() => {
      log("[lifecycle] drain timeout, exiting");
      proc.exit(0);
    }, drainTimeoutMs);
    // close() 立即停止 accept,既有连接(含尚未被 hub 关掉的 upgrade socket)全部结束后回调;Node >= 19 会顺带关掉空闲 keep-alive 连接
    httpServer.close(() => {
      clearTimeout(deadline);
      log("[lifecycle] http server closed, exiting");
      proc.exit(0);
    });
    // hub.close 同步抛、返回非 thenable、或异步拒绝,三种失败都只记日志:这是信号处理器,漏一个就变成停机路径上的 uncaughtException。
    // 仍是同步调用:1012 广播要在排空开始前就发出去。
    /** @type {Promise<unknown>} */
    let closing;
    try {
      closing = Promise.resolve(hub ? hub.close(RESTART_CLOSE_CODE, "server restarting") : undefined);
    } catch (err) {
      closing = Promise.reject(err);
    }
    closing.catch((err) => log(`[lifecycle] hub.close failed: ${describe(err)}`));
  }

  /** @type {Record<string, () => void>} */
  const signalHandlers = {};
  for (const signal of SIGNALS) {
    signalHandlers[signal] = () => shutdown(signal);
    proc.on(signal, signalHandlers[signal]);
  }
  /** @param {unknown} reason */
  const onUnhandledRejection = (reason) => log(`[lifecycle] unhandledRejection (not exiting): ${describe(reason)}`);
  proc.on("unhandledRejection", onUnhandledRejection);

  const rssTimer = setInterval(() => {
    const rssMb = Math.round(proc.memoryUsage().rss / (1024 * 1024));
    log(JSON.stringify({ src: "lifecycle", ev: "rss", rssMb, maxRssMb }));
    if (rssMb > maxRssMb) log(`[lifecycle] warn: rss ${rssMb} MB exceeds MAX_RSS_MB ${maxRssMb}`);
  }, rssIntervalMs);
  rssTimer.unref(); // 采样不该拖住进程退出

  return {
    shutdown,
    dispose() {
      clearInterval(rssTimer);
      for (const signal of SIGNALS) proc.off(signal, signalHandlers[signal]);
      proc.off("unhandledRejection", onUnhandledRejection);
    },
  };
}
