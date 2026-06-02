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
  globalThis.fetch = mockFetchOk({ state: 'lobby', deck: 'fibonacci' });
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
});
