export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.BOT_DISABLED !== "1") {
    const { startMarketBot } = await import("./lib/exchange/bot");
    startMarketBot();
  }
  if (process.env.SYNC_DISABLED !== "1") {
    const { startRealSync } = await import("./lib/real-sync");
    startRealSync();
  }
}
