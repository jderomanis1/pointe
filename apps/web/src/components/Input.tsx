import type { InputHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type InputProps = {
  id: string;
  label?: string;
  error?: string;
  helper?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;

// --ease-mechanical for border/bg transitions; no spring, no blur.
const TRANS = '[transition:border-color_80ms_cubic-bezier(0,0,0.2,1),background-color_80ms_cubic-bezier(0,0,0.2,1)]';

const FIELD_BASE = cn(
  'w-full bg-bg text-text',
  'border border-[var(--border-strong)] rounded-[2px]',
  'px-[14px] py-[10px] text-body font-sans',
  'placeholder:text-text-muted placeholder:italic',
  TRANS,
  // Section 6 focus: outline at 0px offset so it hugs the border; bg lifts to surface.
  'focus-visible:[outline:var(--focus-ring-outline)] focus-visible:[outline-offset:0px] focus-visible:bg-surface',
  'disabled:bg-surface disabled:text-text-muted disabled:border-hairline disabled:cursor-not-allowed',
);

// Applied only in non-error state — avoids hover:border-text conflicting with error border.
const NORMAL_HOVER = 'hover:border-text';

// 2px crimson border + crimson-tinted bg; hover stays error color.
const ERROR_FIELD = cn(
  'border-2 border-error bg-error-surface',
  'hover:border-error',
);

export function Input({
  id, label, error, helper, type = 'text', className, ...rest
}: InputProps) {
  const helperId = helper ? `${id}-helper` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = errorId ?? helperId;
  return (
    <div className="flex flex-col">
      {label ? (
        <label
          htmlFor={id}
          className="mb-1.5 font-mono text-meta uppercase tracking-[0.12em] text-text-secondary"
        >
          {label}
        </label>
      ) : null}
      <input
        id={id}
        type={type}
        className={cn(FIELD_BASE, error ? ERROR_FIELD : NORMAL_HOVER, className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {error ? (
        <p id={errorId} className="mt-1.5 font-mono text-caption text-error">{error}</p>
      ) : helper ? (
        <p id={helperId} className="mt-1 text-caption text-text-muted font-sans">{helper}</p>
      ) : null}
    </div>
  );
}
