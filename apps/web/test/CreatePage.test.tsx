// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CreatePage } from '../src/pages/CreatePage';
import * as api from '../src/lib/api';

describe('CreatePage', () => {
  it('renders the display-name input and the create button', () => {
    render(<MemoryRouter><CreatePage /></MemoryRouter>);
    expect(screen.getByLabelText('Your name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create room' })).toBeInTheDocument();
  });
});

describe('CreatePage — S9.ii.c2 mode toggle', () => {
  beforeEach(() => {
    vi.spyOn(api, 'createRoom').mockResolvedValue({
      ok: true,
      data: { slug: 'apt-sparrow-16', voterId: 'h-1', wsUrl: 'ws://test' },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the sync/async toggle with sync selected by default', () => {
    render(<MemoryRouter><CreatePage /></MemoryRouter>);
    const sync = screen.getByRole('radio', { name: /Live \(sync\)/i });
    const async_ = screen.getByRole('radio', { name: /Async window/i });
    expect(sync).toHaveAttribute('aria-checked', 'true');
    expect(async_).toHaveAttribute('aria-checked', 'false');
  });

  it('default submit sends mode:"sync"', async () => {
    render(<MemoryRouter><CreatePage /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText('Your name'), 'Alice');
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => {
      expect(api.createRoom).toHaveBeenCalledWith({
        hostDisplayName: 'Alice',
        mode: 'sync',
      });
    });
  });

  it('selecting async then submitting sends mode:"async" (no duration at create — picked at OPEN_ASYNC)', async () => {
    render(<MemoryRouter><CreatePage /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText('Your name'), 'Alice');
    await userEvent.click(screen.getByRole('radio', { name: /Async window/i }));
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => {
      expect(api.createRoom).toHaveBeenCalledWith({
        hostDisplayName: 'Alice',
        mode: 'async',
      });
    });
  });
});
