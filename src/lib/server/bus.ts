// bundle 侧取进程内总线:唯一实现在 server/bus.mjs(计划 §3.4、§9.2 D3),这里只负责挂到 globalThis 上并复用。
// server.mjs 先于 next() 就 `globalThis.__carbadiaBus ??= createBus()`,所以 instrumentation 与 route handler 两个 realm
// 里的 getBus() 都直接命中同一份;START_MODE=next(无 server.mjs)时第一次调用才创建,hasSubscribers() 恒 false,发布器跳过一切派生。
import type { CarbadiaBus } from "../../shared/bus";
import { createBus } from "../../../server/bus.mjs";

export function getBus(): CarbadiaBus {
  return (globalThis.__carbadiaBus ??= createBus());
}
