// 手续费预估(计划 §3.5、§9.1 第 1 条):Phase 1 的 FeeSchedule 全零,预估恒为 0 并显示「0.00 · 演示」。
// 费率非零时:fee = max(minFeeCents, ceil(notional × bps / 10000)),预估取上界不低估;费率为 0 即无费,minFee 不生效。

/** 名义额(分)× 万分之 bps 的手续费(分);非法或非正输入返回 0 */
export function estimateFee(notionalCents: number, bps: number, minFeeCents: number): number {
  if (!Number.isFinite(notionalCents) || !Number.isFinite(bps) || notionalCents <= 0 || bps <= 0) return 0;
  const fee = Math.ceil((notionalCents * bps) / 10_000);
  const min = Number.isFinite(minFeeCents) && minFeeCents > 0 ? Math.ceil(minFeeCents) : 0;
  return Math.max(fee, min);
}
