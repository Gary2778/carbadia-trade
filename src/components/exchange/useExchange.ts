"use client";
import { useCallback, useState, useSyncExternalStore } from "react";
import { useLang } from "@/i18n/LangProvider";
import { isChinese } from "@/i18n/config";
import { api } from "@/lib/http/client";
import { usePolling } from "@/hooks/usePolling";
import type { CarbonAsset } from "@/lib/exchange/carbon";
export const useExchangeText = () => {
  const { lang } = useLang();
  return (en: string, zh: string) => (isChinese(lang) ? zh : en);
};
export function useMarket() {
  const [assets, setAssets] = useState<CarbonAsset[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setAssets(await api<CarbonAsset[]>("/api/assets"));
      setHasData(true);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setLoaded(true);
    }
  }, []);
  usePolling(load, 5000);
  return { assets, loaded, hasData, error, reload: load };
}
const KEY = "carbadia-credit-watchlist";
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};
const getSnapshot = () => {
  try {
    return localStorage.getItem(KEY) || "[]";
  } catch {
    return "[]";
  }
};
export function useWatchlist() {
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => "[]");
  let symbols: string[] = [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) symbols = v.filter((x) => typeof x === "string");
  } catch {
    /* invalid saved preference */
  }
  const toggle = (symbol: string) => {
    const next = symbols.includes(symbol)
      ? symbols.filter((x) => x !== symbol)
      : [...symbols, symbol];
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
      emit();
      return true;
    } catch {
      return false;
    }
  };
  return { symbols, toggle };
}
