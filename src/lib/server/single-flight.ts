// 同一个键的并发调用共用一次执行(single-flight;P2-13,P2-11 负载发现 F1):进行中的 Promise 按键记在 globalThis 上,
// 执行结束(成功或失败)即删。只合并「同时在途」的调用,不缓存结果 —— 执行结束之后到的调用重新执行一次,
// 读到的是它自己到达之后的数据(刚成交就重取,不会拿到成交之前缓存下来的旧数)。
// 状态挂 globalThis:本模块会被打进不止一个 bundle(instrumentation、各 route handler、server.mjs 是不同的打包产物),
// 模块级的 Map 每个 bundle 一份,挂 globalThis 才是全进程一份。

declare global {
  /** 键 → 进行中的执行。纯数据,只有本模块读写 */
  var __carbadiaSingleFlight: Map<string, Promise<unknown>> | undefined;
}

/**
 * 键上已有在途的执行就返回它(同一个 Promise:成功时各调用方拿到的是同一个结果对象,不得就地修改;失败时一起失败),
 * 没有就执行 run 并登记,结束即删。
 */
export function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const flights = (globalThis.__carbadiaSingleFlight ??= new Map());
  const inflight = flights.get(key);
  if (inflight) return inflight as Promise<T>;
  // run 推迟一个微任务再执行:即使它同步抛错,清理也总在登记之后发生,键不会留下一个永远不删的失败执行
  const flight: Promise<T> = Promise.resolve()
    .then(run)
    .finally(() => {
      // 只删自己:键上若已换成别的执行(不该发生),不动它
      if (flights.get(key) === flight) flights.delete(key);
    });
  flights.set(key, flight);
  return flight;
}

/** 在途的键数(测试与诊断用) */
export function singleFlightsInProgress(): number {
  return globalThis.__carbadiaSingleFlight?.size ?? 0;
}
