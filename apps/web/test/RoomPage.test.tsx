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
    state: 'lobby', deck: 'fibonacci', mode: 'sync', closesAt: null,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('RoomPage — fresh visit (no router state)', () => {
  it('after the GET resolves, shows JoinForm with name input + role choice + Join button', async () => {
    render(<MemoryRouter><RoomPage slug={SLUG} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('heading', { name: /Join/ })).toBeInTheDocument());
    expect(screen.getByLabelText('Your name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Voter/)).toBeChecked();
    expect(screen.getByLabelText(/Spectator/)).not.toBeChecked();
  });

  it('GET 404 → RoomNotFound', async () => {
    globalThis.fetch = mockFetchOk({ code: 'SLUG_NOT_FOUND', message: 'Room not found' }, 404);
    render(<MemoryRouter><RoomPage slug={SLUG} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'No room here' })).toBeInTheDocument());
  });

  it('sync room: no async framing rendered above the join form', async () => {
    render(<MemoryRouter><RoomPage slug={SLUG} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole('heading', { name: /Join/ })).toBeInTheDocument());
    expect(document.querySelector('[data-slot="async-join-framing"]')).not.toBeInTheDocument();
  });
});

describe('RoomPage — S9.ii.c4 async pre-join framing', () => {
  it('async room with open window → renders the framing card + countdown above the join form', async () => {
    const closesAt = Date.now() + 4 * 3600 * 1000;
    globalThis.fetch = mockFetchOk({
      state: 'active', deck: 'fibonacci', mode: 'async', closesAt,
    });
    render(<MemoryRouter><RoomPage slug={SLUG} /></MemoryRouter>);
    await waitFor(() => {
      expect(document.querySelector('[data-slot="async-join-framing"]')).toBeInTheDocument();
    });
    expect(screen.getByText(/Async voting/)).toBeInTheDocument();
    expect(screen.getByTestId('join-countdown').textContent).toMatch(/4h 0m|3h 59m/);
    // Join form still present beneath the framing.
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
  });

  it('async room with no window opened yet → framing shows "lobby" copy, no countdown', async () => {
    globalThis.fetch = mockFetchOk({
      state: 'lobby', deck: 'fibonacci', mode: 'async', closesAt: null,
    });
    render(<MemoryRouter><RoomPage slug={SLUG} /></MemoryRouter>);
    await waitFor(() => {
      expect(document.querySelector('[data-slot="async-join-framing"]')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('join-countdown')).not.toBeInTheDocument();
    expect(screen.getByText(/hasn['’]t opened the window yet/)).toBeInTheDocument();
  });
});
