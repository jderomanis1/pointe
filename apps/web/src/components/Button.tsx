import type { ButtonHTMLAttributes, ReactNode } from 'react';
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
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
].join(' ');

export function Button({
  variant = 'primary',
  size = 'md',
  leftIcon,
  rightIcon,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(BASE, VARIANT[variant], SIZE[size], className)}
      {...rest}
    >
      {leftIcon ? <span className="inline-flex h-4 w-4 items-center justify-center">{leftIcon}</span> : null}
      {children}
      {rightIcon ? <span className="inline-flex h-4 w-4 items-center justify-center">{rightIcon}</span> : null}
    </button>
  );
}
