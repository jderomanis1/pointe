// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddStory } from '../src/components/room/AddStory';
import { RoomClientProvider } from '../src/components/room/RoomClientContext';

function renderWith(send = vi.fn()) {
  render(
    <RoomClientProvider send={send}>
      <AddStory />
    </RoomClientProvider>,
  );
  return send;
}

describe('AddStory', () => {
  it('submitting with text sends ADD_STORY and clears the input', async () => {
    const send = renderWith();
    const input = screen.getByLabelText('Story') as HTMLInputElement;
    await userEvent.type(input, 'Add password reset');
    await userEvent.click(screen.getByRole('button', { name: 'Add story' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('ADD_STORY', { text: 'Add password reset' });
    expect(input.value).toBe('');
  });

  it('trims surrounding whitespace before sending', async () => {
    const send = renderWith();
    await userEvent.type(screen.getByLabelText('Story'), '   Refactor login   ');
    await userEvent.click(screen.getByRole('button', { name: 'Add story' }));
    expect(send).toHaveBeenCalledWith('ADD_STORY', { text: 'Refactor login' });
  });

  it('empty or whitespace-only text does not send and the button stays disabled', async () => {
    const send = renderWith();
    const button = screen.getByRole('button', { name: 'Add story' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Story'), '   ');
    expect(button).toBeDisabled();
    // Bypass the disabled gate by triggering form submit directly.
    const form = button.closest('form')!;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    expect(send).not.toHaveBeenCalled();
  });
});
