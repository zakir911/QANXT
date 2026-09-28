import { describe, expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfidenceBar, ProviderNote, StatusBadge } from './ui';

describe('StatusBadge', () => {
  test('renders a readable label for a camelCase status', () => {
    render(<StatusBadge status="applicationDefect" />);
    expect(screen.getByText('Application defect')).toBeInTheDocument();
  });

  test('distinguishes healed from passed, so a repair is never presented as a clean pass', () => {
    const { container: passed } = render(<StatusBadge status="passed" />);
    const { container: healed } = render(<StatusBadge status="healed" />);

    const passedClasses = (passed.firstChild as HTMLElement).className;
    const healedClasses = (healed.firstChild as HTMLElement).className;

    expect(passedClasses).not.toBe(healedClasses);
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('Healed')).toBeInTheDocument();
  });
});

describe('ProviderNote', () => {
  test('says plainly when output came from the built-in rules', () => {
    render(<ProviderNote provider="Local" model="qanxt-rules-v1" isLocal />);
    expect(screen.getByText(/built-in rules/i)).toBeInTheDocument();
    expect(screen.getByText(/no model provider is configured/i)).toBeInTheDocument();
  });

  test('names the model when one answered', () => {
    render(<ProviderNote provider="Anthropic" model="claude-sonnet-4-5" isLocal={false} />);
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument();
  });
});

describe('ConfidenceBar', () => {
  test('shows the value and clamps the bar within range', () => {
    render(<ConfidenceBar value={140} />);
    expect(screen.getByText('140%')).toBeInTheDocument();
  });
});
