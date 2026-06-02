import { useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { SPLIT_MAX_CHILDREN, SPLIT_MIN_CHILDREN } from '@pointe/shared';
import { Button } from '../Button';
import { Input } from '../Input';
import { useSend } from './RoomClientContext';
import { cn } from '../../lib/cn';

/**
 * Host split form. Inline; starts with two child-text inputs, "Add another"
 * grows up to SPLIT_MAX_CHILDREN, X removes (down to the minimum). Submit
 * (accent — the form's primary action) sends SPLIT_STORY when at least
 * SPLIT_MIN_CHILDREN non-empty texts exist. Cancel collapses the form.
 *
 * SI-04: inputs are controlled strings, rendered with React's default
 * escaping (no dangerouslySetInnerHTML).
 */
export function SplitForm({
  storyId, onClose,
}: {
  storyId: string;
  onClose: () => void;
}) {
  const send = useSend();
  const [texts, setTexts] = useState<string[]>(
    Array.from({ length: SPLIT_MIN_CHILDREN }, () => ''),
  );

  function updateAt(idx: number, value: string) {
    setTexts((prev) => prev.map((t, i) => (i === idx ? value : t)));
  }
  function add() {
    if (texts.length >= SPLIT_MAX_CHILDREN) return;
    setTexts((prev) => [...prev, '']);
  }
  function removeAt(idx: number) {
    if (texts.length <= SPLIT_MIN_CHILDREN) return;
    setTexts((prev) => prev.filter((_, i) => i !== idx));
  }
  const nonEmpty = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  const canSubmit = nonEmpty.length >= SPLIT_MIN_CHILDREN;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    // Send only the non-empty trimmed texts so a half-filled extra row doesn't
    // ship a blank child. Server validates again — defense in depth.
    send('SPLIT_STORY', {
      storyId,
      children: nonEmpty.map((text) => ({ text })),
    });
    onClose();
  }

  return (
    <form
      onSubmit={submit}
      className="bg-fill border border-hairline rounded-md p-4 mt-3 flex flex-col gap-3"
    >
      <p className="text-meta text-text-secondary">
        Split into smaller stories — each goes back to the queue as pending.
      </p>
      <ul className="flex flex-col gap-2">
        {texts.map((t, idx) => (
          <li key={idx} className="flex items-end gap-2">
            <div className="flex-1">
              <Input
                id={`split-child-${idx}`}
                label={`Child ${idx + 1}`}
                placeholder="Smaller story text"
                value={t}
                onChange={(e) => updateAt(idx, e.target.value)}
              />
            </div>
            <button
              type="button"
              aria-label={`Remove child ${idx + 1}`}
              disabled={texts.length <= SPLIT_MIN_CHILDREN}
              onClick={() => removeAt(idx)}
              className={cn(
                'inline-flex h-8 w-8 items-center justify-center rounded-md',
                'text-text-secondary hover:text-text hover:bg-surface transition-colors duration-fast',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                'disabled:cursor-not-allowed disabled:text-text-disabled',
              )}
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={add}
          disabled={texts.length >= SPLIT_MAX_CHILDREN}
          leftIcon={<Plus size={14} />}
        >
          Add another
        </Button>
        <span className="text-meta text-text-muted">
          {nonEmpty.length} / {SPLIT_MAX_CHILDREN}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
            Split into {nonEmpty.length || SPLIT_MIN_CHILDREN}
          </Button>
        </div>
      </div>
    </form>
  );
}
