import type { ReactNode } from "react";

/** Shared product masthead, matching the original Atlas heading. */
export function ProductPageHeader({
  eyebrow,
  title,
  description,
  meta,
  id,
}: {
  eyebrow: string;
  title: string;
  description: string;
  meta?: ReactNode;
  id?: string;
}) {
  return (
    <header id={id} className="pt-6 border-b border-border pb-6">
      <p className="font-mono text-xs tracking-[0.3em] text-accent mb-2">{eyebrow}</p>
      <h1 className="font-serif text-4xl sm:text-5xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted text-lg mt-3 leading-relaxed">{description}</p>
      {meta && <p className="text-xs text-muted mt-2">{meta}</p>}
    </header>
  );
}
