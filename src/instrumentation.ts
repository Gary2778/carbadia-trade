export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  // 先补齐标的(与 BOT_DISABLED 无关): 新 symbol 创建、旧行回填元数据; bot 下一 tick 才能为新标的补铸并报价。
  // 失败只告警不阻塞——标的缺几条不该让整个服务起不来(与 shadow 的"失败只告警"一致)。
  try {
    const { ensureInstruments } = await import("./lib/exchange/ensure-instruments");
    const { created, backfilled } = await ensureInstruments();
    console.log(`[instruments] created=${created.length} backfilled=${backfilled.length}`);
  } catch (e) {
    console.error("[instruments] ensure 失败", e);
  }
  // 预读一次标的列表,填满 globalThis.__carbadiaInstrumentsCache(P1-25e),hub 据此核实 symbol,不必对「没法核实」的 symbol 放行。
  // 注意生产下 listen 并不等本函数跑完:NextCustomServer.prepare() 只建路由服务,NextNodeServer 在构造时并发地触发 prepare → register
  //(next/dist/server/next-server.js:「fire prepare as soon as possible」),HTTP 请求(含 Railway 的健康检查)会等 register 完成,
  // /ws 的 upgrade 不经过 Next、不等。所以 listen 之后到这里完成之前(本地实测几百毫秒)仍可能有没法核实的 symbol,
  // 由 hub 的按连接与全 hub 限流兜底;部署时流量在健康检查通过之后才切过来,那时预读已经完成。
  // 与 BOT_DISABLED 无关;失败只告警——第一个页面请求会照常再查。
  try {
    const { listInstruments } = await import("./lib/server/market-snapshots");
    const { instruments } = await listInstruments();
    console.log(`[instruments] listed=${instruments.length}`);
  } catch (e) {
    console.error("[instruments] 预读标的列表失败", e);
  }
  if (process.env.BOT_DISABLED !== "1") {
    const { startMarketBot } = await import("./lib/exchange/bot");
    startMarketBot();
  }
  // 条件单触发引擎(计划 §6.3.2 C4):排在机器人之后,与 BOT_DISABLED 无关(人与人的成交照样触发);TRIGGERS_DISABLED=1 时它自己什么都不做。
  // 它订阅总线,START_MODE=next(没有 hub)下发布器因此也发 trades。
  const { startTriggerEngine } = await import("./lib/server/trigger-engine");
  startTriggerEngine();
  if (process.env.SYNC_DISABLED !== "1") {
    const { startRealSync } = await import("./lib/real-sync");
    startRealSync();
  }
}
