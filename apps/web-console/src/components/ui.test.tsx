import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FilterNote, Metric, StatusBadge, useMetricFilter } from './ui';

function Tiles() {
  const filter = useMetricFilter<'failed'>();
  const rows = [{ name: 'login', status: 'failed' }, { name: 'search', status: 'passed' }];
  return (
    <>
      <Metric label="Failed" value={1} onClick={() => filter.toggle('failed')} active={filter.is('failed')} />
      <FilterNote label={filter.filter ? 'Failed' : null} onClear={() => filter.set(null)} />
      <ul>{rows.filter(r => !filter.filter || r.status === filter.filter).map(r => <li key={r.name}>{r.name}</li>)}</ul>
    </>
  );
}

describe('metric tiles', () => {
  test('a tile filters the list below it, and pressing it again shows everything', () => {
    render(<Tiles />);
    const tile = screen.getByRole('button', { name: /Failed/ });
    expect(tile).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    fireEvent.click(tile);
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual(['login']);

    fireEvent.click(tile);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  test('a tile with nothing to filter stays a plain number', () => {
    render(<Metric label="Duration" value="3 min" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('status badge', () => {
  test('work in progress turns; a verdict does not', () => {
    const { rerender } = render(<StatusBadge status="running" />);
    expect(screen.getByTestId('status-spinner')).toBeInTheDocument();
    rerender(<StatusBadge status="queued" />);
    expect(screen.getByTestId('status-spinner')).toBeInTheDocument();
    rerender(<StatusBadge status="passed" />);
    expect(screen.queryByTestId('status-spinner')).toBeNull();
  });
});
