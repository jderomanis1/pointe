// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CreatePage } from '../src/pages/CreatePage';
import * as api from '../src/lib/api';

describe('CreatePage — live-only session creation', () => {
  beforeEach(() => {
    vi.spyOn(api, 'createRoom').mockResolvedValue({
      ok: true,
      data: { slug: 'apt-sparrow-16', voterId: 'h-1', wsUrl: 'ws://test' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders one name field and one create action with no mode selection', () => {
    render(<MemoryRouter><CreatePage /></MemoryRouter>);
    expect(screen.getByLabelText('Your name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Session' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Async/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Live \(sync\)/i })).not.toBeInTheDocument();
  });

  it('creates a sync room without asking the user to choose a mode', async () => {
    render(<MemoryRouter><CreatePage /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText('Your name'), 'Alice');
    await userEvent.click(screen.getByRole('button', { name: 'Create Session' }));
    await waitFor(() => {
      expect(api.createRoom).toHaveBeenCalledWith({
        hostDisplayName: 'Alice',
        mode: 'sync',
      });
    });
  });
});
