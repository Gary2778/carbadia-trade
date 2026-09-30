"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePolling } from "@/hooks/usePolling";
import { api, ApiError } from "@/lib/http/client";
import { fmtMoney, fmtQty } from "@/lib/format";
import { Reveal } from "@/components/anim/Reveal";
import { useToast } from "@/components/anim/Toast";
import { ComplianceNote } from "@/components/ComplianceNote";
import { useT, useLang } from "@/i18n/LangProvider";
import { tName, tUserName } from "@/i18n/data";
import { accountActions, useAccountStatus, useMe } from "@/lib/market/account-store";

type Listing = {
  id: string;
  quantity: number;
  pricePerUnit: number;
  minQuantity: number;
  createdAt: string;
  sellerId: string;
  asset: { symbol: string; name: string; standard: string; projectType: string; vintage: number };
  seller: { name: string };
};
type Asset = { id: string; symbol: string; name: string };

/** 写操作回 401:会话在这页上过期了,让共享的账户 store 重新确认身份(Nav 与本页的登录入口随之变成未登录) */
function recheckLoginOn401(e: unknown): void {
  if (e instanceof ApiError && e.status === 401) void accountActions.refresh();
}

export default function OtcPage() {
  const t = useT("otc");
  const { lang } = useLang();
  const pathname = usePathname();
  const [listings, setListings] = useState<Listing[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  // 登录态读共享的账户 store(Nav 挂载时拉的那份,换路径时 Nav 节流刷新),不再每 5 s 随挂牌一起拉 /api/auth/me。
  // SSR 与水合首帧 store 是 idle(身份未知):与原来「第一次加载回来之前」一样按加载中画,身份确定后再画买入 / 撤牌 / 登录入口
  const me = useMe() ?? null;
  const status = useAccountStatus();
  const accountKnown = status === "ready" || status === "anon";
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const [ls, a] = await Promise.all([api<Listing[]>("/api/otc"), api<Asset[]>("/api/assets")]);
      setListings(ls);
      setAssets(a);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  // 轮询而非一次性加载:别人新发布的挂牌、被买走的挂牌都能自动出现/消失
  usePolling(load, 5000);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">{t.title}</h1>
          <p className="text-muted text-sm">{t.subtitle}</p>
          <ComplianceNote className="mt-1" />
        </div>
        {me && (
          <button
            onClick={() => setShowCreate((s) => !s)}
            className="px-4 py-2 rounded-full bg-accent text-background text-sm font-medium hover:bg-accent-strong transition-colors hover:opacity-90"
          >{showCreate ? t.collapse : t.newListing}</button>
        )}
      </div>

      {/* 已有数据时刷新失败只提示,不遮挡列表;无数据时的错误在下方卡片里展示 */}
      {err && listings.length > 0 && <div className="text-danger text-sm">{err}</div>}

      {showCreate && me && <CreateListing assets={assets} onDone={() => { setShowCreate(false); load(); }} />}

      <Reveal>
        <div className="rounded-2xl border border-border bg-surface shadow-card overflow-hidden">
          {loading || !accountKnown ? (
            <div className="p-10 text-center text-muted">{t.loading}</div>
          ) : listings.length === 0 && err ? (
            <div className="p-10 text-center text-danger">{err}</div>
          ) : listings.length === 0 ? (
            <div className="p-10 text-center text-muted">{t.emptyPre}{!me && <>{t.emptyMid}<Link href={`/login?returnTo=${encodeURIComponent(pathname)}`} className="text-accent">{t.emptyLogin}</Link>{t.emptyPost}</>}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-muted text-xs">
                  <tr className="border-b border-border">
                    <th className="text-start px-5 py-3 font-medium">{t.thInstrument}</th>
                    <th className="text-start px-3 py-3 font-medium hidden md:table-cell">{t.thSeller}</th>
                    <th className="text-end px-3 py-3 font-medium">{t.thUnitPrice}</th>
                    <th className="text-end px-3 py-3 font-medium">{t.thAvailable}</th>
                    <th className="text-end px-3 py-3 font-medium hidden sm:table-cell">{t.thMinBuy}</th>
                    <th className="text-end px-5 py-3 font-medium">{t.thAction}</th>
                  </tr>
                </thead>
                <tbody>
                  {listings.map((l) => (
                    <tr key={l.id} className="border-b border-border/40 hover:bg-surface-2">
                      <td className="px-5 py-3">
                        <Link href={`/market/${l.asset.symbol}`} className="font-medium hover:text-accent">{l.asset.symbol}</Link>
                        <div className="text-xs text-muted truncate max-w-[180px]">{tName(l.asset.symbol, l.asset.name, lang)}</div>
                      </td>
                      <td className="px-3 py-3 text-muted hidden md:table-cell">{tUserName(l.seller.name, lang)}</td>
                      <td className="px-3 py-3 text-end tnum text-accent">${fmtMoney(l.pricePerUnit)}</td>
                      <td className="px-3 py-3 text-end tnum">{fmtQty(l.quantity)}</td>
                      <td className="px-3 py-3 text-end tnum text-muted hidden sm:table-cell">{fmtQty(l.minQuantity)}</td>
                      <td className="px-5 py-3 text-end">
                        {me?.id === l.sellerId ? (
                          <CancelListing id={l.id} onDone={load} />
                        ) : me ? (
                          <BuyListing listing={l} onDone={load} />
                        ) : (
                          <Link href={`/login?returnTo=${encodeURIComponent(pathname)}`} className="text-xs text-accent">{t.loginToBuy}</Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Reveal>
    </div>
  );
}

function CreateListing({ assets, onDone }: { assets: Asset[]; onDone: () => void }) {
  const t = useT("otc");
  const toast = useToast();
  const [assetId, setAssetId] = useState(assets[0]?.id ?? "");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [minQty, setMinQty] = useState("1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    setBusy(true); setErr("");
    try {
      await api("/api/otc", {
        method: "POST",
        body: JSON.stringify({
          assetId,
          quantity: Number(quantity),
          pricePerUnit: Math.round(Number(price) * 100), // 输入框是元, API 收整数分
          minQuantity: Number(minQty) || 1,
        }),
      });
      toast("ok", t.listingPublished);
      onDone();
    } catch (e) {
      recheckLoginOn401(e);
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-border bg-surface shadow-card p-5 space-y-3">
      <h2 className="font-semibold text-sm">{t.createTitle}</h2>
      <p className="text-xs text-muted">{t.createHint}</p>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <label className="block sm:col-span-1">
          <span className="text-xs text-muted">{t.fieldInstrument}</span>
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}
            className="w-full mt-1 bg-surface-2 border border-border rounded-md px-2 py-2 text-sm outline-none focus:border-accent">
            {assets.map((a) => <option key={a.id} value={a.id}>{a.symbol}</option>)}
          </select>
        </label>
        <Field label={t.fieldQuantity} value={quantity} onChange={setQuantity} />
        <Field label={t.fieldUnitPrice} value={price} onChange={setPrice} step="0.01" />
        <Field label={t.fieldMinBuy} value={minQty} onChange={setMinQty} />
      </div>
      {err && <div className="text-danger text-xs">{err}</div>}
      <button onClick={submit} disabled={busy || !assetId || !quantity || !price}
        className="px-4 py-2 rounded-full bg-accent text-background text-sm font-medium hover:bg-accent-strong transition-colors disabled:opacity-40">
        {busy ? t.submitting : t.confirmPublish}
      </button>
    </div>
  );
}

function Field({ label, value, onChange, step }: { label: string; value: string; onChange: (v: string) => void; step?: string }) {
  return (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      {/* 移动端键盘类型:整数字段弹九宫格,带小数步进的价格字段弹小数键盘 */}
      <input type="number" min="0" step={step ?? "1"} inputMode={step ? "decimal" : "numeric"} value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full mt-1 bg-surface-2 border border-border rounded-xl px-3.5 py-2.5 text-sm tnum outline-none focus:border-accent" />
    </label>
  );
}

function BuyListing({ listing, onDone }: { listing: Listing; onDone: () => void }) {
  const t = useT("otc");
  const tm = useT("market");
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState(String(listing.minQuantity));
  const [busy, setBusy] = useState(false);

  // 客户端校验:整数、不低于起购量、不超过可售量;非法时禁用确认按钮
  const qtyNum = Number(qty);
  const qtyValid = Number.isInteger(qtyNum) && qtyNum >= listing.minQuantity && qtyNum <= listing.quantity;
  // 确认前实时总价:数量 × 单价(整数分),让用户在花钱前看到总额
  const estTotal = Number.isInteger(qtyNum) && qtyNum > 0 ? qtyNum * listing.pricePerUnit : null;

  if (!open) return <button onClick={() => setOpen(true)} className="text-xs px-3 py-1 min-h-11 sm:min-h-0 inline-flex items-center rounded bg-up text-background font-medium">{t.buy}</button>;

  async function buy() {
    setBusy(true);
    try {
      await api(`/api/otc/${listing.id}/buy`, { method: "POST", body: JSON.stringify({ quantity: Number(qty) }) });
      // 买入扣了现金:立刻刷新共享的账户 store,Nav 的现金不等下一次导航
      void accountActions.refresh();
      toast("ok", t.bought(qty));
      setOpen(false);
      onDone();
    } catch (e) {
      recheckLoginOn401(e);
      toast("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1 justify-end">
        <input type="number" inputMode="numeric" value={qty} min={listing.minQuantity} max={listing.quantity}
          aria-label={t.fieldQuantity} onChange={(e) => setQty(e.target.value)}
          className="w-16 min-h-11 sm:min-h-0 bg-surface-2 border border-border rounded px-2 py-1 text-xs tnum outline-none focus:border-accent" />
        <button onClick={buy} disabled={busy || !qtyValid} className="text-xs px-2 py-1 min-h-11 sm:min-h-0 inline-flex items-center rounded bg-up text-background font-medium disabled:opacity-40">
          {busy ? "…" : t.confirm}
        </button>
        <button onClick={() => setOpen(false)} aria-label={t.collapse} className="text-xs text-muted px-1 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center">×</button>
      </div>
      {/* 与行情页 estTotal 同款小字:确认前先看到 数量 × 单价 的总额 */}
      {estTotal != null && (
        <div className="text-xs text-muted flex gap-1">
          <span>{tm.estTotal}</span>
          <span className="tnum text-foreground">${fmtMoney(estTotal)}</span>
        </div>
      )}
    </div>
  );
}

function CancelListing({ id, onDone }: { id: string; onDone: () => void }) {
  const t = useT("otc");
  const tm = useT("market");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    // 撤牌成功补 toast,与行情页撤单反馈对齐;触控目标移动端拉到 44px,桌面观感不变
    <button disabled={busy} onClick={async () => { setBusy(true); try { await api(`/api/otc/${id}`, { method: "DELETE" }); toast("ok", tm.cancelled); onDone(); } catch (e) { recheckLoginOn401(e); toast("err", (e as Error).message); setBusy(false); } }}
      className="text-xs text-muted hover:text-danger disabled:opacity-40 min-h-11 sm:min-h-0 inline-flex items-center">{t.cancelListing}</button>
  );
}
