import type { InputHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export type InputProps = {
  id: string;
  label?: string;
  error?: string;
  helper?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>;

const FIELD_BASE = [
  'w-full bg-surface text-text',
  'border border-hairline rounded-md',
  'px-3 py-2 text-body font-sans',
  'placeholder:text-text-muted',
  'transition-colors duration-fast',
  'focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent',
  'disabled:bg-fill disabled:text-text-disabled disabled:cursor-not-allowed',
].join(' ');

export function Input({
  id, label, error, helper, type = 'text', className, ...rest
}: InputProps) {
  const helperId = helper ? `${id}-helper` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = errorId ?? helperId;
  return (
    <div className="flex flex-col">
      {label ? (
        <label htmlFor={id} className="text-meta text-text-secondary mb-1 font-sans">
          {label}
        </label>
      ) : null}
      <input
        id={id}
        type={type}
        className={cn(FIELD_BASE, error ? 'border-error focus-visible:border-error focus-visible:ring-error' : '', className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {error ? (
        <p id={errorId} className="mt-1 text-caption text-error font-sans">{error}</p>
      ) : helper ? (
        <p id={helperId} className="mt-1 text-caption text-text-muted font-sans">{helper}</p>
      ) : null}
    </div>
  );
}
