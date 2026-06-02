// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../src/components/Button';

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Vote</Button>);
    expect(screen.getByRole('button', { name: 'Vote' })).toBeInTheDocument();
  });

  it('fires onClick when clicked', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Reveal</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disabled blocks the handler and sets the disabled attribute', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick} disabled>Reveal</Button>);
    const btn = screen.getByRole('button', { name: 'Reveal' });
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('variant="primary" applies the bg-accent class', () => {
    render(<Button variant="primary">Go</Button>);
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass('bg-accent');
  });

  it('defaults type to "button" (not "submit")', () => {
    render(<Button>Safe</Button>);
    expect(screen.getByRole('button', { name: 'Safe' })).toHaveAttribute('type', 'button');
  });
});
