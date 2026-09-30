"use client";

import { useId, type ReactNode } from "react";
import type { Instrument } from "@/shared";
import { Skeleton } from "@/components/ui/Skeleton";
import { useLang, useT } from "@/i18n/LangProvider";
import { tProjectType, tRegistry } from "@/i18n/data";
import { getCreditProfile } from "@/lib/exchange/carbon";
import { useInstrument } from "@/lib/market/selectors";
import { useTerminalLayout } from "./useTerminalLayout";

export type CarbonMetaPanelProps = {
  symbol: string;
  /** initialInstruments 里当前 symbol 的 instrument(SSR 首屏);store 有该键后以 store 为准 */
  initial?: Instrument;
};

/** 模拟项目编号的前缀(计划 §9.1 第 15 条:SIM-PRJ-<STANDARD>-<TYPE>,不是登记机构的项目编号) */
const SIMULATED_PROJECT_PREFIX = "SIM-PRJ-";

const filled = (s: string | null | undefined): s is string => typeof s === "string" && s.trim() !== "";

/**
 * 碳信用元数据面板(计划 §3.1、§1.1「碳市场特有的部分不靠杜撰」、§9.1 第 15 条):
 *   - 项目类型、方法学、年份、注册机构、核证状态、项目编号六项;值缺失(null、空串、非正整数年份)一律显示
 *     terminal.meta.notProvided,不补、不猜;
 *   - 核证状态只可能是 SIMULATED_UNVERIFIED(字面联合,边界已收窄),显示 simulatedUnverified 并带「模拟」标记;
 *   - 项目编号以 SIM-PRJ- 开头时加注 simulatedProjectId(模拟编号,不是登记机构记录);
 *   - 注册机构只链 getCreditProfile().registryUrl(按 standard 取,不拼任何项目级 URL;情景标的不链)。链接文字用中性的
 *     terminal.meta.registrySite「登记处或项目方网站」:CDM 的地址是项目检索页、ACCU 是计划页,不都是登记簿首页(§9.2 D20);
 *   - 情景标的顶部标 terminal.meta.scenario;
 *   - < 48rem(手机页签里)折叠成 <details>(计划 §4.7「碳元数据折叠」);服务端快照恒 desktop,首帧是展开的面板。
 * SSR 规则:store 值 ?? props 值 —— 服务端与水合首帧 store 为空,标记只来自 initial;渲染期不写 store。
 */
export function CarbonMetaPanel({ symbol, initial }: CarbonMetaPanelProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const titleId = useId();
  const collapsed = useTerminalLayout() === "mobile";
  const instrument = useInstrument(symbol) ?? initial;

  let body: ReactNode;
  if (!instrument) body = <Skeleton rows={6} />;
  else {
    const notProvided = (
      <span data-not-provided="" className="text-muted-2">
        {t.meta.notProvided}
      </span>
    );
    const registryUrl = instrument.isScenario ? undefined : getCreditProfile(instrument).registryUrl;
    const projectId = instrument.projectId;
    const fields: { key: string; label: string; value: ReactNode }[] = [
      { key: "projectType", label: t.meta.projectType, value: filled(instrument.projectType) ? tProjectType(instrument.projectType, lang) : notProvided },
      { key: "methodology", label: t.meta.methodology, value: filled(instrument.methodology) ? instrument.methodology : notProvided },
      {
        key: "vintage",
        label: t.meta.vintage,
        value: Number.isInteger(instrument.vintage) && instrument.vintage > 0 ? <span className="tnum">{instrument.vintage}</span> : notProvided,
      },
      {
        key: "registry",
        label: t.meta.registry,
        value: filled(instrument.registry) ? (
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-gap">
            <span>{tRegistry(instrument.registry, lang)}</span>
            {registryUrl ? (
              <a
                href={registryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 rounded-chip text-t-2xs text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus"
              >
                {t.meta.registrySite}
                <svg aria-hidden="true" viewBox="0 0 16 16" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3h7v7M13 3L6 10M11 13H3V5" />
                </svg>
              </a>
            ) : null}
          </span>
        ) : (
          notProvided
        ),
      },
      {
        key: "verification",
        label: t.meta.verification,
        value:
          instrument.verificationStatus === "SIMULATED_UNVERIFIED" ? (
            <span data-simulated="" className="inline-flex rounded-chip bg-warning-soft px-1.5 text-t-xs text-warning">
              {t.meta.simulatedUnverified}
            </span>
          ) : (
            notProvided
          ),
      },
      {
        key: "projectId",
        label: t.meta.projectId,
        value: filled(projectId) ? (
          <span className="flex min-w-0 flex-col">
            <span className="tnum break-all">{projectId}</span>
            {projectId.startsWith(SIMULATED_PROJECT_PREFIX) ? (
              <span data-simulated="" className="text-t-2xs text-warning">
                {t.meta.simulatedProjectId}
              </span>
            ) : null}
          </span>
        ) : (
          notProvided
        ),
      },
    ];
    body = (
      <div className="flex min-h-0 flex-col gap-gap">
        {instrument.isScenario ? (
          <p data-scenario="" className="self-start rounded-chip bg-warning-soft px-1.5 text-t-xs text-warning">
            {t.meta.scenario}
          </p>
        ) : null}
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-panel gap-y-1 text-t-sm leading-t-tight">
          {fields.map((f) => (
            <div key={f.key} data-meta={f.key} className="contents">
              <dt className="text-muted">{f.label}</dt>
              <dd className="min-w-0 text-foreground">{f.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-t-2xs text-muted-2">{t.meta.unit}</p>
      </div>
    );
  }

  return (
    <section
      data-area="meta"
      aria-labelledby={titleId}
      className="flex min-h-0 min-w-0 flex-col gap-gap overflow-auto rounded-panel border border-(--terminal-border) bg-(--terminal-panel) p-panel"
    >
      {collapsed ? (
        <details className="flex flex-col gap-gap">
          <summary id={titleId} className="flex min-h-touch cursor-pointer items-center text-t-md font-semibold leading-t-tight focus-visible:outline-none focus-visible:shadow-focus">
            {t.mobile.meta}
          </summary>
          {body}
        </details>
      ) : (
        <>
          <h2 id={titleId} className="text-t-md font-semibold leading-t-tight">
            {t.meta.title}
          </h2>
          {body}
        </>
      )}
    </section>
  );
}
