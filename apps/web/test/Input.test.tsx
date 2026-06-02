// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input } from '../src/components/Input';

describe('Input', () => {
  it('label association: getByLabelText finds the field', () => {
    render(<Input id="name" label="Display name" value="" onChange={() => undefined} />);
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
  });

  it('typing fires onChange', async () => {
    const onChange = vi.fn();
    render(<Input id="name" label="Display name" value="" onChange={onChange} />);
    await userEvent.type(screen.getByLabelText('Display name'), 'A');
    expect(onChange).toHaveBeenCalled();
  });

  it('error sets aria-invalid and wires aria-describedby to the error text', () => {
    render(<Input id="name" label="Name" value="" onChange={() => undefined} error="Required" />);
    const field = screen.getByLabelText('Name');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    const describedBy = field.getAttribute('aria-describedby');
    expect(describedBy).toBe('name-error');
    expect(document.getElementById(describedBy!)).toHaveTextContent('Required');
  });

  it('disabled disables the field', () => {
    render(<Input id="name" label="Name" value="x" onChange={() => undefined} disabled />);
    expect(screen.getByLabelText('Name')).toBeDisabled();
  });
});
