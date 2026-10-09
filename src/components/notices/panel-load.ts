// 铃铛加载面板 chunk 的状态机(纯 reducer,node 环境可测;NoticeBell 只负责发 import() 与派发)。
// 为什么不用 React.lazy:它缓存 rejected 的 promise,chunk 加载失败(断网、部署换代后的旧标签页)之后同一个懒组件永远是失败的,
// 重试也没用;这里每次重试重新 import(),动作带着尝试序号,迟到的上一次结果(重试已经开始、或已卸载)一律丢弃。
// ready = 面板组件已经拿到(模块级缓存,之后每次打开直接 ready)。
export type PanelLoad = { phase: "loading"; attempt: number } | { phase: "failed"; attempt: number } | { phase: "ready" };

export type PanelLoadAction = { kind: "loaded"; attempt: number } | { kind: "failed"; attempt: number } | { kind: "retry" };

export const startPanelLoad = (alreadyLoaded: boolean): PanelLoad => (alreadyLoaded ? { phase: "ready" } : { phase: "loading", attempt: 0 });

export function reducePanelLoad(state: PanelLoad, action: PanelLoadAction): PanelLoad {
  switch (action.kind) {
    case "loaded":
      return state.phase === "loading" && state.attempt === action.attempt ? { phase: "ready" } : state;
    case "failed":
      return state.phase === "loading" && state.attempt === action.attempt ? { phase: "failed", attempt: state.attempt } : state;
    case "retry":
      return state.phase === "failed" ? { phase: "loading", attempt: state.attempt + 1 } : state;
  }
}
