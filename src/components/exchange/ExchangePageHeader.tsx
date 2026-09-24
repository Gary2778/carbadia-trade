"use client";

import { ProductPageHeader } from "@/components/ProductPageHeader";
import { useT } from "@/i18n/LangProvider";

export function ExchangePageHeader() {
  const t = useT("exchange");
  return (
    <ProductPageHeader
      eyebrow="TRADE"
      title="Carbadia Trade"
      description={t.tagline}
    />
  );
}
