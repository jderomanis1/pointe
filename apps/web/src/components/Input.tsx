import type { InputHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type InputProps = {
  id: string;
  label?: string;
  error?: string;
  helper?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;

const TRANS = '[transition:border-color_120ms_cubic-bezier(0.2,0.8,0.2,1),background-color_120ms_cubic-bezier(0.2,0.8,0.2,1),box-shadow_120ms_cubic-bezier(0.2,0.8,0.2,1)]';

const FIELD_BASE = cn(
  'w-full bg-bg text-text',
  'border border-hairline rounded-[14px]',
  'px-4 py-3 text-body font-sans shadow-[inset_0_1px_0_rgba(255,255,255,.04)]',
  'placeholder:text-text-muted',
  TRANS,
  'focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20 focus-visible:bg-surface',
  'disabled:bg-surface disabled:text-text-muted disabled:border-hairline disabled:cursor-not-allowed',
);

const NORMAL_HOVER = 'hover:border-text-muted';
const ERROR_FIELD = 'border-2 border-error bg-error-surface hover:border-error';

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
          className="mb-2 text-meta font-bold uppercase tracking-[0.1em] text-text-secondary"
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
        <p id={errorId} className="mt-1.5 text-caption font-semibold text-error-on">{error}</p>
      ) : helper ? (
        <p id={helperId} className="mt-1.5 text-caption text-text-muted">{helper}</p>
      ) : null}
    </div>
  );
}
