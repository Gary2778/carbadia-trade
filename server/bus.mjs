// @ts-check
// 进程内总线的唯一实现(计划 §3.4 契约表、§9.2 D3)。
// 纯 JS、零模块级状态、无 class:本文件会被打进三个 realm(server.mjs、instrumentation、route handler),
// 所以状态只能活在 createBus() 返回的闭包里,而那个对象只挂一份在 globalThis.__carbadiaBus 上
// (server.mjs 先于 next() 创建;bundle 侧经 src/lib/server/bus.ts 的 getBus() 取同一份)。
// 同步扇出:publish 在调用栈内依次调用每个订阅者;某个订阅者抛异常不影响其余订阅者,只计数并打日志。
// 日志限流:一个坏掉的订阅者会在每条 book / ticker 上都抛(bot 每 2.5 s × 14 个标的,P1-10 之后更多),按消息速率打日志会淹掉
// 真正的错误、撑爆 Railway 日志;所以前 LOG_FIRST_N 次逐条记,之后每分钟至多一条,计数照常累加。
// 消息形状见 src/shared/bus.ts 的 BusMessage(下面只做 JSDoc 类型引用,运行时不导入 src/**)。

/** @typedef {import("../src/shared/bus").BusMessage} BusMessage */
/** @typedef {import("../src/shared/bus").CarbadiaBus} CarbadiaBus */

const LOG_FIRST_N = 10;
const LOG_INTERVAL_MS = 60_000;

/**
 * @returns {CarbadiaBus & { subscriberErrors(): number }}
 */
export function createBus() {
  /** @type {Set<(msg: BusMessage) => void>} */
  const subscribers = new Set();
  let errors = 0;
  let lastLoggedAt = -Infinity;
  return {
    publish(msg) {
      for (const fn of subscribers) {
        try {
          fn(msg);
        } catch (err) {
          errors += 1;
          const now = Date.now();
          if (errors <= LOG_FIRST_N || now - lastLoggedAt >= LOG_INTERVAL_MS) {
            lastLoggedAt = now;
            console.error(`[bus] subscriber threw on ${msg.kind} (${errors} so far)`, err);
          }
        }
      }
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    hasSubscribers() {
      return subscribers.size > 0;
    },
    /** 订阅者抛异常的累计次数(诊断用,不在 CarbadiaBus 类型里;日志限流不影响计数) */
    subscriberErrors() {
      return errors;
    },
  };
}
