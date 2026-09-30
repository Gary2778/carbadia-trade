// @ts-check
// 自定义 Node 入口(计划 §3.4):同一个端口上跑 Next(页面与 REST)和 WebSocket(/ws 行情推送)。
// 不经 Next 编译,必须是 Node 22 能直接跑的纯 JS。生产由 docker-entrypoint.sh `exec node server.mjs` 启动;
// START_MODE=next 时 entrypoint 改走 `next start`(无 /ws,前端自动降级轮询),这是一变量回滚开关。
// 为什么不用 next start:Next 16 的 route handler 拿不到 socket,做不了 WebSocket;
// Railway 对 WebSocket 不设时长/空闲上限,而普通 HTTP 流 5 分钟无数据即断、最长 15 分钟,所以推送选 WebSocket。
//
// 形态 = 21b5a1a 已在生产模式验证过的骨架 + bus / hub / lifecycle:
//   next({ dev, hostname, port })(不传 httpServer / dir)→ await app.prepare()(生产下 NextNodeServer 构造时即并发地发起
//   instrumentation.register():补标的、预读标的、做市机器人、影子同步;prepare 与 listen 都**不等**它完成 —— HTTP 请求(含健康检查)
//   在 Next 内部会等 register,/ws 不经过 Next、不等,见计划 §3.4)→ getRequestHandler / getUpgradeHandler → createServer(handle) → attachWsHub(listen 之前注册
//   upgrade 监听;非 /ws 的 upgrade 在 dev 转交 Next 的 HMR,生产一律 socket.destroy(),不写 HTTP 响应,原因见 §3.3)→ installLifecycle
//   (SIGTERM → hub.close(1012) → server.close → exit;keepAliveTimeout 65 s)→ listen。
// 三个 realm(本文件、instrumentation bundle、route handler bundle)只经 globalThis 共享:__carbadiaBus 在 next() 之前创建,
// bundle 侧 getBus() 直接命中;__carbadiaWsStats / __carbadiaPresence / __carbadiaTopicSeq 由 hub 维护。
import { createServer } from "node:http";
import process from "node:process";
import next from "next";
import { createBus } from "./server/bus.mjs";
import { installLifecycle } from "./server/lifecycle.mjs";
import { resolveSessionSecret } from "./server/session.mjs";
import { DEFAULT_MAX_CONNECTIONS, DEFAULT_MAX_PER_IP, DEFAULT_MAX_UNTRUSTED, attachWsHub, parseAllowedOrigins } from "./server/ws-hub.mjs";
import { WS_HEARTBEAT_MS } from "./server/ws-schema.mjs"; // 协议常量(hello.heartbeatMs 也是它),不在这里另抄一份

const DEFAULT_PORT = 3000;
const DEFAULT_MAX_RSS_MB = 900;

/**
 * 端口:命令行 -p / --port(与 next dev 同名,.claude/launch.json 不用改)优先,其次 PORT,默认 3000。
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 */
function readPort(argv, env) {
  /** @type {string | undefined} */
  let fromArgs;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--port") fromArgs = argv[i + 1];
    else if (arg.startsWith("--port=")) fromArgs = arg.slice("--port=".length);
    else if (arg.startsWith("-p=")) fromArgs = arg.slice("-p=".length);
  }
  const raw = fromArgs ?? env.PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`invalid port: ${raw}`);
  return port;
}

/**
 * 正整数环境变量,缺省或非法时用默认值(全部变量都有代码内默认,Railway 不需要新增)。
 * @param {string} name
 * @param {number} fallback
 */
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** @param {string} line */
const log = (line) => console.log(line);

const dev = process.env.NODE_ENV !== "production";
const port = readPort(process.argv.slice(2), process.env);
const hostname = process.env.HOST ?? "0.0.0.0";
const wsDisabled = process.env.WS_DISABLED === "1";

globalThis.__carbadiaBus ??= createBus(); // 先于 next():bundle 侧 getBus() 直接命中同一份

const app = next({ dev, hostname, port });
await app.prepare(); // 生产下 register() 在 NextNodeServer 构造时已并发发起,这里不等它完成;getUpgradeHandler 必须在 prepare 之后取
const handle = app.getRequestHandler();
const nextUpgrade = app.getUpgradeHandler(); // dev 模式的 HMR 也走 upgrade,必须转交给 Next

const httpServer = createServer((req, res) => {
  handle(req, res);
});

const hub = attachWsHub(httpServer, {
  path: "/ws",
  bus: globalThis.__carbadiaBus,
  // 与 auth.ts 同一条密钥规则:dev 没设 SESSION_SECRET 时用 DEV_SESSION_SECRET,否则 dev 签的 cookie 到 /ws 验不过;
  // 生产缺失或等于开发默认值时是 undefined,hub 全部按匿名(fail closed)并记一行错误
  secret: resolveSessionSecret(),
  proxySecret: process.env.PROXY_SECRET,
  allowedOrigins: parseAllowedOrigins(process.env, dev),
  maxConnections: intEnv("WS_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS),
  maxPerIp: intEnv("WS_MAX_PER_IP", DEFAULT_MAX_PER_IP),
  maxUntrusted: intEnv("WS_MAX_UNTRUSTED", DEFAULT_MAX_UNTRUSTED), // 直连源站(不经 Worker)的连接共用的上限
  heartbeatMs: WS_HEARTBEAT_MS,
  disabled: wsDisabled,
  dev,
  nextUpgrade,
  log,
});

installLifecycle({ httpServer, hub, log, maxRssMb: intEnv("MAX_RSS_MB", DEFAULT_MAX_RSS_MB) });

httpServer.listen(port, hostname, () => {
  log(`[server] Next + WebSocket listening on http://${hostname}:${port} (${dev ? "dev" : "production"})`);
  log(wsDisabled ? "[ws] disabled (WS_DISABLED=1): /ws not mounted, clients fall back to polling" : "[ws] listening /ws");
});
