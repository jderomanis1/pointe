import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export type BadgeVariant = 'neutral' | 'accent' | 'warning' | 'success' | 'error';

export type BadgeProps = {
  variant?: BadgeVariant;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
};

const VARIANT: Record<BadgeVariant, string> = {
  neutral: 'bg-fill text-text-secondary',
  accent: 'bg-accent-tint text-accent',
  warning: 'bg-warning-surface text-warning-on',
  success: 'bg-success-surface text-success-on',
  error: 'bg-error-surface text-error-on',
};

const BASE = 'inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-caption font-sans font-medium';

export function Badge({ variant = 'neutral', icon, className, children }: BadgeProps) {
  return (
    <span className={cn(BASE, VARIANT[variant], className)}>
      {icon ? <span className="inline-flex h-3 w-3 items-center justify-center">{icon}</span> : null}
      {children}
    </span>
  );
}
