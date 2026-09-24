// 做市机器人定价数学 — 全部纯函数, 随机性经 rng 注入以便测试。价格一律整数分。
export type Rng = () => number;

/** 公允价(整数分): 三角分布噪声(±0.4%) + 2% 力度向 anchor 均值回归, 下限 1 分 */
export function nextFair(last: number, anchor: number, rng: Rng): number {
  const noise = (rng() + rng() - 1) * 0.004;
  return Math.max(1, Math.round(last * (1 + noise) + 0.02 * (anchor - last)));
}

/** 两侧各 5 档报价: 偏移 0.1%~1.06%, 数量 10~200 吨, 价格整数分 */
export function buildQuoteLevels(fair: number, rng: Rng) {
  const mk = (dir: 1 | -1) =>
    Array.from({ length: 5 }, (_, i) => {
      const pct = 0.001 + i * 0.0022 + rng() * 0.0008;
      return {
        price: Math.max(1, Math.round(fair * (1 + dir * pct))),
        quantity: 10 + Math.floor(rng() * 191),
      };
    });
  return { asks: mk(1), bids: mk(-1) };
}

/** 30% 概率发吃单 */
export const shouldTake = (rng: Rng) => rng() < 0.3;

/** 吃单量 10~80 吨 */
export const takeQty = (rng: Rng) => 10 + Math.floor(rng() * 71);
