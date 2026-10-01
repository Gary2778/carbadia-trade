// 合并后的完整英文文案(核心 + terminal + account):只给类型与测试用。
// 运行时代码不得引入本文件(计划 §6.2.2 C9):根 LangProvider 只静态引入 ./core/*,终端文案(./terminal/*)只随 /trade 的
// chunk 加载,资产页文案(./account/*,P2-10)只随 /trade/account 的 chunk 加载;从根布局可达的模块一旦引入这里,
// 这两份文案就又回到全站每页的公共包里(src/i18n/bundle-boundary.test.ts 守着)。
// 要加 / 改文案:核心命名空间改 ./core/en.ts,终端改 ./terminal/en.ts,资产页改 ./account/en.ts。
import account from "./account/en";
import core from "./core/en";
import terminal from "./terminal/en";

const en = { ...core, terminal, account };

export type Messages = typeof en;
export default en;
