import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { quoteTerms } from '../../shared/contracts';
import { QuoteDisclosure, type CompetitionQuote } from '../../web/src/components/Competition';

const quote: CompetitionQuote = {
  terms: quoteTerms(100, 500), termsHash: 'a'.repeat(64), feeBps: 500,
  mode: 'test', label: 'Internal test credit example',
  disclosures: ['No real money is used.', 'Draws refund both stakes.'],
  allowed: true, blockers: [],
};

describe('QuoteDisclosure', () => {
  it('renders exact integer-cent fee mathematics', () => {
    render(<QuoteDisclosure quote={quote} />);
    expect(screen.getByText('USD $2.00')).toBeInTheDocument();
    expect(screen.getByText('USD $0.10')).toBeInTheDocument();
    expect(screen.getByText('USD $1.90')).toBeInTheDocument();
    expect(screen.getByText(/Full refund, no fee/)).toBeInTheDocument();
  });

  it('requires explicit acceptance of exact terms', () => {
    const onAccept = vi.fn();
    render(<QuoteDisclosure quote={quote} showAccept accepted={false} onAccept={onAccept} />);
    const checkbox = screen.getByRole('checkbox', { name: /accept these exact competition terms/i });
    fireEvent.click(checkbox);
    expect(onAccept).toHaveBeenCalledWith(true);
  });

  it('shows precise blockers when a quote is not allowed', () => {
    render(<QuoteDisclosure quote={{ ...quote, allowed: false, blockers: ['Legal authorisation has not been verified.'] }} />);
    expect(screen.getByText(/Not available/)).toBeInTheDocument();
    expect(screen.getByText(/Legal authorisation has not been verified/)).toBeInTheDocument();
  });
});
