// 交易输入护栏(分)。价格与单笔名义额上限保证所有 Int 金额字段与流水 delta 不溢出 32 位。
export const MAX_PRICE_CENTS = 100_000_000; // $1,000,000 / 吨
export const MAX_NOTIONAL_CENTS = 1_000_000_000; // $10,000,000 / 单
