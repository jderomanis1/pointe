// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CreatePage } from '../src/pages/CreatePage';

describe('CreatePage', () => {
  it('renders the display-name input and the create button', () => {
    render(<MemoryRouter><CreatePage /></MemoryRouter>);
    expect(screen.getByLabelText('Your name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create room' })).toBeInTheDocument();
  });
});
