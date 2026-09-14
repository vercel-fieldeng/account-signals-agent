import type { HTMLAttributes, JSX } from 'react';

/**
 * A minimal Geist-styled surface container.
 *
 * `@vercel/geistcn` (>= 1.0.0) no longer ships a generic `Card`; only
 * specialized cards (`error-card`, `context-card`) remain. This local
 * composition reproduces the classic card surface with `--ds-*` tokens so
 * both light and dark themes render correctly.
 */
export function Card({
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={`rounded-lg border border-[var(--ds-gray-alpha-400)] bg-[var(--ds-background-100)] ${className}`}
      {...props}
    />
  );
}
