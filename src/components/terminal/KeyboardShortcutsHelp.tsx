"use client";

import { useId } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n/LangProvider";
import { HOTKEYS, hotkeyKeyLabel, shortcutRows } from "@/lib/market/hotkeys";

export type KeyboardShortcutsHelpProps = { open: boolean; onClose: () => void };

/** 每一行 = HOTKEYS 里同一 label 的全部快捷键;模块级算一次(表是常量) */
const ROWS = shortcutRows(HOTKEYS);

/**
 * 快捷键帮助(计划 §3.1、§3.6、§4.7):按 ? 打开,基于 ui/Dialog(原生 <dialog>,Esc / 背景 / 关闭按钮关闭,焦点还原)。
 * 表格由 HOTKEYS 生成(shortcutRows 按 terminal.shortcuts.<label> 分组,与 HOTKEYS 一一对应),不另写一份键位清单;
 * 左列键帽(hotkeyKeyLabel,按键名不翻译),右列 terminal.shortcuts.* 的说明;脚注 pointerOnly —— 快捷键只在键鼠设备上启用。
 * TerminalShell 经 next/dynamic({ ssr: false }) 懒加载、只在打开时挂载。
 */
export function KeyboardShortcutsHelp({ open, onClose }: KeyboardShortcutsHelpProps) {
  const t = useT("terminal");
  const noteId = useId();
  return (
    <Dialog open={open} onClose={onClose} title={t.shortcuts.title} describedBy={noteId}>
      <dl data-shortcuts="" className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-panel gap-y-1 text-t-sm leading-t-tight">
        {ROWS.map((row) => (
          <div key={row.label} data-shortcut={row.label} className="contents">
            <dt className="flex flex-wrap gap-1">
              {row.hotkeys.map((hotkey) => (
                <kbd
                  key={`${hotkey.mod ?? ""}+${hotkey.key}`}
                  className="tnum inline-flex min-w-5 justify-center rounded-chip border border-border bg-surface-2 px-1 font-mono text-t-xs text-foreground"
                >
                  {hotkeyKeyLabel(hotkey)}
                </kbd>
              ))}
            </dt>
            <dd className="min-w-0 text-muted">{t.shortcuts[row.label]}</dd>
          </div>
        ))}
      </dl>
      <p id={noteId} className="text-t-xs text-muted-2">
        {t.shortcuts.pointerOnly}
      </p>
    </Dialog>
  );
}
