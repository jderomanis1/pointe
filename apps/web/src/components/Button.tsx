import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  children: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover active:bg-accent-active disabled:bg-fill disabled:text-text-disabled',
  secondary: 'bg-surface text-text border border-hairline hover:bg-fill disabled:text-text-disabled disabled:bg-surface',
  ghost: 'text-text hover:bg-fill disabled:text-text-disabled',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'text-meta px-3 py-1.5',
  md: 'text-body px-4 py-2',
  lg: 'text-subhead px-6 py-3',
};

const BASE = [
  'inline-flex items-center justify-center gap-2',
  'rounded-md font-sans font-medium',
  'transition-colors duration-fast',
  'disabled:cursor-not-allowed',
  // S10 a11y-keyboard §1 (resolved A): accent ring with a 2 px bg-colored
  // offset. The primary variant has `bg-accent`, so a flush `ring-accent`
  // would be accent-on-accent (invisible). The offset paints a 2 px gap
  // in `--color-bg` between the button edge and the ring, so the ring
  // reads as accent-on-bg regardless of the variant's fill. Token-only:
  // `ring-offset-bg` resolves to `--color-bg` via Tailwind v4's
  // `@theme inline` bridge in styles/index.css. Same offset on every
  // variant — secondary/ghost already-visible aren't regressed; the
  // tiny halo is a small consistency win.
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  'focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
].join(' ');

// `forwardRef` so callers can take a ref to the underlying <button> —
// used by S10 a11y-keyboard §2 (REVEAL→Commit focus, CommitPanel).
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    leftIcon,
    rightIcon,
    type = 'button',
    className,
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(BASE, VARIANT[variant], SIZE[size], className)}
      {...rest}
    >
      {leftIcon ? <span className="inline-flex h-4 w-4 items-center justify-center">{leftIcon}</span> : null}
      {children}
      {rightIcon ? <span className="inline-flex h-4 w-4 items-center justify-center">{rightIcon}</span> : null}
    </button>
  );
});
