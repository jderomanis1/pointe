// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RoomPage } from '../src/pages/RoomPage';

const SLUG = 'apt-sparrow-16';

function mockFetchOk(body: object, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.fetch = mockFetchOk({
    state: 'active', deck: 'fibonacci', mode: 'sync', closesAt: null,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('RoomPage — fresh visit', () => {
  it('shows a direct join form with name, role, and Join button', async () => {
    render(<MemoryRouter><RoomPage slug={SLUG} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('heading', { name: /Join and start voting/i })).toBeInTheDocument());
    expect(screen.getByLabelText('Your name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Voter/)).toBeChecked();
    expect(screen.getByLabelText(/Spectator/)).not.toBeChecked();
    expect(document.querySelector('[data-slot="async-join-framing"]')).not.toBeInTheDocument();
  });

  it('GET 404 → RoomNotFound', async () => {
    globalThis.fetch = mockFetchOk({ code: 'SLUG_NOT_FOUND', message: 'Room not found' }, 404);
    render(<MemoryRouter><RoomPage slug={SLUG} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'No table is open here.' })).toBeInTheDocument());
  });

  it('does not expose async framing even for a legacy async room', async () => {
    globalThis.fetch = mockFetchOk({
      state: 'active', deck: 'fibonacci', mode: 'async', closesAt: Date.now() + 3600000,
    });
    render(<MemoryRouter><RoomPage slug={SLUG} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('heading', { name: /Join and start voting/i })).toBeInTheDocument());
    expect(document.querySelector('[data-slot="async-join-framing"]')).not.toBeInTheDocument();
    expect(screen.queryByText(/Async voting/i)).not.toBeInTheDocument();
  });
});
