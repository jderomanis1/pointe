// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App';

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('NotFound routing', () => {
  it('reserved path /about → NotFound', () => {
    renderAt('/about');
    expect(screen.getByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });

  it('non-slug path /xyz → NotFound', () => {
    renderAt('/xyz');
    expect(screen.getByRole('heading', { name: 'Not found' })).toBeInTheDocument();
  });

  it('reserved /preview shows the preview, not NotFound', () => {
    renderAt('/preview');
    expect(screen.queryByRole('heading', { name: 'Not found' })).not.toBeInTheDocument();
  });
});
