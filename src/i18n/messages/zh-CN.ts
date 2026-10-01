// 合并后的完整简体中文文案(核心 + terminal + account):只给类型与测试用,运行时代码不得引入(见 ./en.ts 的说明)。
import account from "./account/zh-CN";
import type { Messages } from "./en";
import core from "./core/zh-CN";
import terminal from "./terminal/zh-CN";

const zhCN: Messages = { ...core, terminal, account };

export default zhCN;
