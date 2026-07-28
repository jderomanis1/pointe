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

const TRANS = '[transition:transform_120ms_cubic-bezier(0.2,0.8,0.2,1),box-shadow_120ms_cubic-bezier(0.2,0.8,0.2,1),background-color_120ms_cubic-bezier(0.2,0.8,0.2,1),border-color_120ms_cubic-bezier(0.2,0.8,0.2,1),color_120ms_cubic-bezier(0.2,0.8,0.2,1),opacity_120ms_cubic-bezier(0.2,0.8,0.2,1)]';

const VARIANT: Record<ButtonVariant, string> = {
  primary: cn(
    'bg-accent text-accent-ink border border-accent font-bold',
    'shadow-[var(--shadow-hard-sm)]',
    'hover:bg-accent-hover hover:-translate-y-0.5 hover:shadow-[var(--shadow-hard-md)]',
    'active:translate-y-0 active:shadow-[var(--shadow-hard-sm)]',
    'disabled:bg-fill disabled:text-text-muted disabled:border-hairline disabled:shadow-none disabled:opacity-60',
  ),
  secondary: cn(
    'bg-surface text-text border border-[var(--border-strong)] font-semibold',
    'shadow-[var(--shadow-hard-sm)]',
    'hover:bg-fill hover:-translate-y-0.5 hover:shadow-[var(--shadow-hard-md)]',
    'active:translate-y-0 active:shadow-[var(--shadow-hard-sm)]',
    'disabled:bg-surface disabled:text-text-muted disabled:border-hairline disabled:shadow-none disabled:opacity-50',
  ),
  ghost: cn(
    'bg-transparent text-text-secondary border border-transparent',
    'hover:text-text hover:border-hairline hover:bg-fill',
    'active:bg-surface active:text-accent-text',
    'disabled:text-text-muted disabled:opacity-40',
  ),
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'min-h-9 text-meta px-3 py-1.5',
  md: 'min-h-11 text-body px-5 py-2.5',
  lg: 'min-h-12 text-subhead px-6 py-3',
};

const BASE = cn(
  'inline-flex items-center justify-center gap-2 rounded-full font-sans tracking-[-0.01em]',
  TRANS,
  'disabled:cursor-not-allowed',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg',
);

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
