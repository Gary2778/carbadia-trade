"use client";

import { Component, type ReactNode } from "react";
import { ErrorState } from "@/components/ui/ErrorState";
import { useT } from "@/i18n/LangProvider";

// 通知面板内容外面的错误边界(随懒加载的面板 chunk 走,不进 floor 包):面板渲染时抛错不再把整页卸掉,
// 而是显示与「chunk 加载失败」同一个错误态(core.notices.error + 重试);重试把边界复位,面板内容重新挂载(重新取第一页)。
// 只接得住渲染期的错误;事件处理与异步回调里的错误本来就不会卸载页面。

function PanelFailed({ onRetry }: { onRetry: () => void }) {
  const t = useT("notices");
  return <ErrorState message={t.error} onRetry={onRetry} />;
}

export class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  // 接住的错误照样记一行(否则面板静静地显示错误态,控制台里什么都没有)
  componentDidCatch(error: unknown): void {
    console.error("[notices] panel render failed", error);
  }

  render(): ReactNode {
    return this.state.failed ? <PanelFailed onRetry={() => this.setState({ failed: false })} /> : this.props.children;
  }
}
