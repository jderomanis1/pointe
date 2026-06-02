// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '../src/components/Badge';

describe('Badge', () => {
  it('renders children', () => {
    render(<Badge>Voted</Badge>);
    expect(screen.getByText('Voted')).toBeInTheDocument();
  });

  it('variant="warning" applies the warning-surface class (the low-confidence chip)', () => {
    render(<Badge variant="warning">Low confidence</Badge>);
    const el = screen.getByText('Low confidence');
    expect(el).toHaveClass('bg-warning-surface');
    expect(el).toHaveClass('text-warning-on');
  });
});
