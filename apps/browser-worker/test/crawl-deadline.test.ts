import { describe, expect, it } from 'vitest';
import { crawlDeadline } from '../src/discovery/crawler.js';

/**
 * A budget that resets is not a budget.
 *
 * The crawl's deadline used to be computed when the worker process started crawling, so a
 * job reclaimed after a worker died began a fresh full budget. Measured on this project's
 * own test lab: a run with a declared 900-second budget was still mapping pages twenty
 * minutes in, because a restart had reset its clock. On a real application that is the
 * difference between "explore for fifteen minutes" and an open-ended crawl.
 */
describe('when a crawl must stop', () => {
  const minute = 60_000;
  const now = 1_000_000_000;

  it('measures the budget from when the run began, not when this worker picked it up', () => {
    // The run started five minutes ago; a 15-minute budget leaves ten.
    const deadline = crawlDeadline(900, now - 5 * minute, now);
    expect(deadline).toBe(now - 5 * minute + 900_000);
    expect(deadline - now).toBe(10 * minute);
  });

  it('does not hand a reclaimed job a second full budget', () => {
    const fresh = crawlDeadline(900, undefined, now);
    const reclaimed = crawlDeadline(900, now - 10 * minute, now);
    expect(reclaimed).toBeLessThan(fresh);
  });

  it('gives a job reclaimed past its budget a short window rather than a deadline in the past', () => {
    // Stopping instantly would mean reporting nothing, which leaves the run looking
    // stranded and throws away every page already crawled.
    const deadline = crawlDeadline(900, now - 40 * minute, now);
    expect(deadline).toBeGreaterThan(now);
    expect(deadline - now).toBe(30_000);
  });

  it('never gives more grace than the budget itself', () => {
    // A 10-second budget must not become a 30-second one on reclaim.
    const deadline = crawlDeadline(10, now - 60 * minute, now);
    expect(deadline - now).toBe(10_000);
  });

  it('falls back to the full budget from now when the run start is unknown', () => {
    expect(crawlDeadline(900, undefined, now)).toBe(now + 900_000);
  });

  it('treats a nonsense budget as no time at all rather than as time travel', () => {
    expect(crawlDeadline(-5, undefined, now)).toBe(now);
  });
});
