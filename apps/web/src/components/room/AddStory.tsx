import { useState, type FormEvent } from 'react';
import { Button } from '../Button';
import { Input } from '../Input';
import { useSend } from './RoomClientContext';

/**
 * Host-only add-story control. Sends ADD_STORY; the round-trip story_added DELTA
 * appends to the queue via the store reducer — no optimistic insert.
 */
export function AddStory() {
  const send = useSend();
  const [text, setText] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    send('ADD_STORY', { text: trimmed });
    setText('');
  }

  const canSubmit = text.trim().length > 0;

  return (
    <form onSubmit={submit} className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
      <div className="flex-1">
        <Input
          id="add-story"
          label="Story"
          placeholder="e.g. Add password reset"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <Button type="submit" variant="primary" disabled={!canSubmit}>
        Add story
      </Button>
    </form>
  );
}
