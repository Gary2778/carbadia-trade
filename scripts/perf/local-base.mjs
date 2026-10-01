// @ts-check
// 会改库的度量脚本(建演示账号、下单、注销)只对本地开发主机跑:localhost、127.0.0.1、[::1],或以 .localhost / .test 结尾。
// retire-latency.mjs 与 demo-account.mjs 共用;要对别处跑必须显式 --allow-remote。

/** @param {string} base 形如 http://localhost:3982 @returns {boolean} */
export function isLocalBase(base) {
  let host = "";
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost") || host.endsWith(".test");
}

/** 拒绝时的说明 @param {string} base */
export function refuseRemoteMessage(base) {
  return `refusing ${base}: not a local development host (localhost / 127.0.0.1 / [::1] / *.localhost / *.test). This script writes to the server's database (demo account, orders, retirements); pass --allow-remote only if you really mean it`;
}
