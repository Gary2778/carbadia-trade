// 均线指标纯函数(计划 §3.5、§3.6):整段 sma / ema 供 setData,smaLast / emaNext 供实时只更新最后一根。
// 值可以是任意数(分),输出不取整;period 不是正整数时整段返回 null。

const validPeriod = (period: number): boolean => Number.isSafeInteger(period) && period > 0;

/** 简单移动平均:前 period − 1 位为 null */
export function sma(values: number[], period: number): (number | null)[] {
  if (!validPeriod(period)) return values.map(() => null);
  const out: (number | null)[] = new Array(values.length);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out[i] = i >= period - 1 ? sum / period : null;
  }
  return out;
}

/** 指数移动平均:第 period 根以前 period 根的 SMA 起算,之后 ema = prev + k × (value − prev),k = 2 / (period + 1) */
export function ema(values: number[], period: number): (number | null)[] {
  if (!validPeriod(period)) return values.map(() => null);
  const out: (number | null)[] = new Array(values.length);
  let sum = 0;
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    if (prev == null) {
      sum += values[i];
      if (i === period - 1) prev = sum / period;
      out[i] = prev;
      continue;
    }
    prev = emaNext(prev, values[i], period);
    out[i] = prev;
  }
  return out;
}

/** 最后 period 个值的均值;不足 period 个返回 null */
export function smaLast(values: number[], period: number): number | null {
  if (!validPeriod(period) || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/** 已知上一根 EMA,喂进新值得到下一根;period 非法按 1(即返回 value) */
export function emaNext(prevEma: number, value: number, period: number): number {
  const k = validPeriod(period) ? 2 / (period + 1) : 1;
  return prevEma + k * (value - prevEma);
}
