import { render, screen } from '@testing-library/react';
import Home from '../../src/app/page';

describe('Home', () => {
  it('renders the KEMFAI heading without requiring auth or tenant context', () => {
    render(<Home />);

    expect(screen.getByRole('heading', { name: 'KEMFAI' })).toBeInTheDocument();
  });
});
