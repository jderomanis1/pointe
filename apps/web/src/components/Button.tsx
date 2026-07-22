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

// --ease-snap micro-interaction timing, declared explicitly since Tailwind's
// default easing doesn't match the spec's cubic-bezier(0.1, 0.9, 0.2, 1).
const TRANS = '[transition:transform_80ms_cubic-bezier(0.1,0.9,0.2,1),box-shadow_80ms_cubic-bezier(0.1,0.9,0.2,1),background-color_80ms_cubic-bezier(0.1,0.9,0.2,1),border-color_80ms_cubic-bezier(0.1,0.9,0.2,1),color_80ms_cubic-bezier(0.1,0.9,0.2,1),opacity_80ms_cubic-bezier(0.1,0.9,0.2,1)]';

const VARIANT: Record<ButtonVariant, string> = {
  // Section 3.4 — high-priority actions (EXECUTE REVEAL, CREATE SESSION)
  primary: cn(
    'bg-accent text-white border border-accent font-bold',
    'shadow-[var(--shadow-hard-sm)]',
    'hover:bg-accent-hover hover:-translate-x-px hover:-translate-y-px hover:shadow-[var(--shadow-hard-md)]',
    'active:bg-accent-hover active:translate-x-px active:translate-y-px active:shadow-none',
    'disabled:bg-fill disabled:text-[var(--text-tertiary)] disabled:border-hairline disabled:shadow-none disabled:opacity-60',
  ),
  // Section 3.5 — structural actions (COPY INVITE LINK, TOGGLE OBSERVER)
  secondary: cn(
    'bg-surface text-text border border-[var(--border-strong)] font-semibold',
    'shadow-[var(--shadow-hard-sm)]',
    'hover:bg-fill hover:-translate-x-px hover:-translate-y-px hover:shadow-[var(--shadow-hard-md)]',
    'active:translate-x-px active:translate-y-px active:shadow-none',
    'disabled:bg-surface disabled:text-[var(--text-tertiary)] disabled:border-hairline disabled:shadow-none disabled:opacity-50',
  ),
  // Section 3.6 — low-emphasis actions (LEAVE SESSION, TOGGLE THEME)
  ghost: cn(
    'bg-transparent text-text-secondary border border-transparent',
    'hover:text-text hover:border-hairline hover:bg-fill',
    'active:bg-surface active:text-accent',
    'disabled:text-[var(--text-tertiary)] disabled:opacity-40',
  ),
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'text-meta px-3 py-1.5',
  md: 'text-body px-4 py-2',
  lg: 'text-subhead px-5 py-2.5',
};

const BASE = cn(
  'inline-flex items-center justify-center gap-2',
  'rounded-[2px] font-mono uppercase tracking-[0.08em]',
  TRANS,
  'disabled:cursor-not-allowed',
  // Section 6 focus-visible: outline ring, no box-shadow ring.
  // [outline-offset] inherits the 2px spec value; ghost overrides to 0px inline.
  'focus-visible:[outline:2px_solid_var(--border-focus)] focus-visible:[outline-offset:2px]',
);

// `forwardRef` so callers can ref the underlying <button> (CommitPanel focus
// management after reveal).
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
