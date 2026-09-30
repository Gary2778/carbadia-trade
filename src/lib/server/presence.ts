// 发布器的第二级门控(计划 §3.2、§3.4「globalThis 总线契约与两级门控」):hub 在 subscribe / unsubscribe / close 时
// 增减 globalThis.__carbadiaPresence = { users: Map<userId, n>, topics: Map<Topic, n> },发布器只在有人订阅时才做派生计算
//(读盘口算差分、折 K 线桶、查账户)。没有 hub(START_MODE=next、WS_DISABLED)时 __carbadiaPresence 不存在 → 一律无兴趣。
// 本模块零状态、零 DB:同一份 Map 被三个 bundle 读,谁读都一样。
import type { Topic } from "../../shared/ws-protocol";

/** 有人订阅 topic 吗?ticker:* 有订阅视为对所有 ticker:SYM 有兴趣(计划 §3.4);book / trades / candles 没有通配 */
export function hasInterest(topic: Topic): boolean {
  const topics = globalThis.__carbadiaPresence?.topics;
  if (!topics) return false;
  if ((topics.get(topic) ?? 0) > 0) return true;
  return topic.startsWith("ticker:") && (topics.get("ticker:*") ?? 0) > 0;
}

/** 该用户有 account 订阅的连接吗?users 计的是连接数(同一用户多标签页各算一个) */
export function hasUser(userId: string): boolean {
  return (globalThis.__carbadiaPresence?.users.get(userId) ?? 0) > 0;
}
