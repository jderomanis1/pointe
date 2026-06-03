// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Story } from '@pointe/shared';
import { StoryExternalRef } from '../src/components/room/StoryExternalRef';

function s(overrides: Partial<Story> = {}): Story {
  return {
    id: 's-1', roomId: 'r-1', orderIndex: 100, text: 't', state: 'pending',
    edited: false, createdAt: 0, ...overrides,
  };
}

describe('<StoryExternalRef /> — OQ-014 link-out + SI-04 safety', () => {
  it('renders a safe link with rel/target when externalUrl is set; label = externalId', () => {
    render(<StoryExternalRef story={s({ externalId: 'PROJ-42', externalUrl: 'https://jira.example.com/PROJ-42' })} />);
    const link = screen.getByRole('link', { name: 'PROJ-42' });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute('href')).toBe('https://jira.example.com/PROJ-42');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders a link with the generic "link" label when externalUrl is set but externalId is not', () => {
    render(<StoryExternalRef story={s({ externalUrl: 'https://example.com/x' })} />);
    const link = screen.getByRole('link', { name: 'link' });
    expect(link.getAttribute('href')).toBe('https://example.com/x');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('renders externalId as inert text (no link) when externalUrl is absent', () => {
    render(<StoryExternalRef story={s({ externalId: 'PROJ-100' })} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('PROJ-100')).toBeInTheDocument();
  });

  it('renders nothing when neither externalId nor externalUrl is present', () => {
    const { container } = render(<StoryExternalRef story={s()} />);
    expect(container.firstChild).toBeNull();
  });

  it('SI-04: externalId / label render as inert text — markup is escaped, not interpreted', () => {
    // The externalId could in theory hold attacker-controlled content if a
    // tracker exposes one. React text-children escape — verify here.
    render(
      <StoryExternalRef story={s({
        externalId: '<img src=x onerror="alert(1)">',
        externalUrl: 'https://example.com/x',
      })} />,
    );
    // No img element rendered.
    expect(document.querySelector('img')).toBeNull();
    // The "id" text is escaped, so it appears verbatim inside the link.
    const link = screen.getByRole('link');
    expect(link.textContent).toContain('<img');
    expect(link.innerHTML).not.toContain('<img'); // escaped to &lt;img
  });

  it('SI-04: href is the externalUrl verbatim; no dangerouslySetInnerHTML anywhere', () => {
    render(<StoryExternalRef story={s({ externalUrl: 'https://example.com/x?a=1&b=2' })} />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('https://example.com/x?a=1&b=2');
  });
});
