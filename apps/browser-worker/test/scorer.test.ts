import { describe, expect, test } from 'vitest';
import { geometrySimilarity, pathSimilarity, scoreCandidates, stringSimilarity } from '../src/healing/scorer.js';
import type { RawElement } from '../src/discovery/page-extractor.js';

/**
 * The scorer decides whether a test is repaired or left broken, so its behaviour is
 * pinned down here rather than only observed through an end-to-end run.
 */

function element(overrides: Partial<RawElement> = {}): RawElement {
  return {
    kind: 'button',
    tagName: 'button',
    ariaRole: 'button',
    accessibleName: 'Sign in',
    text: 'Sign in',
    label: null,
    placeholder: null,
    testId: 'login-submit',
    elementId: null,
    name: null,
    type: 'submit',
    title: null,
    value: null,
    cssSelector: 'form > button',
    xpath: '/html[1]/body[1]/form[1]/button[1]',
    domPath: 'html/body/main/form/button',
    parentSignature: 'div|||row',
    neighbourText: 'Remember me',
    bounding: { x: 40, y: 430, width: 84, height: 41 },
    isVisible: true,
    isEnabled: true,
    isRequired: false,
    attributes: { type: 'submit' },
    ...overrides
  };
}

describe('string similarity', () => {
  test('identical strings score 1', () => {
    expect(stringSimilarity('Sign in', 'Sign in')).toBe(1);
  });

  test('is insensitive to case and punctuation', () => {
    expect(stringSimilarity('Sign In!', 'sign in')).toBe(1);
  });

  test('containment scores highly', () => {
    expect(stringSimilarity('login-submit', 'login-submit-v2')).toBeGreaterThan(0.8);
  });

  test('a renamed label still scores above an unrelated one', () => {
    const renamed = stringSimilarity('Sign in', 'Log in');
    const unrelated = stringSimilarity('Sign in', 'Delete account');
    expect(renamed).toBeGreaterThan(unrelated);
  });

  test('empty input scores 0', () => {
    expect(stringSimilarity('', 'Sign in')).toBe(0);
  });
});

describe('path similarity', () => {
  test('identical paths score 1', () => {
    expect(pathSimilarity('html/body/form/button', 'html/body/form/button')).toBe(1);
  });

  test('a shared tail scores partially', () => {
    const score = pathSimilarity('html/body/main/form/button', 'html/body/div/main/form/button');
    expect(score).toBeGreaterThanOrEqual(0.5);
    expect(score).toBeLessThan(1);
  });

  test('unrelated paths score 0', () => {
    expect(pathSimilarity('html/body/form/button', 'html/head/title')).toBe(0);
  });
});

describe('geometry similarity', () => {
  test('the same box scores 1', () => {
    const box = { x: 10, y: 20, width: 100, height: 40 };
    expect(geometrySimilarity(box, box)).toBeCloseTo(1, 5);
  });

  test('a distant box of a different size scores low', () => {
    const score = geometrySimilarity(
      { x: 10, y: 20, width: 100, height: 40 },
      { x: 700, y: 600, width: 10, height: 10 });
    expect(score).toBeLessThan(0.2);
  });
});

describe('candidate scoring', () => {
  test('an unchanged element is a near-perfect match', () => {
    const [best] = scoreCandidates({
      brokenLocator: { strategy: 'testId', value: 'login-submit' },
      fingerprint: {
        tagName: 'button', ariaRole: 'button', accessibleName: 'Sign in',
        testId: 'login-submit', type: 'submit', domPath: 'html/body/main/form/button'
      },
      candidates: [element()]
    });

    expect(best).toBeDefined();
    expect(best!.similarity).toBeGreaterThanOrEqual(95);
  });

  test('a renamed control is still identified with usable confidence', () => {
    const renamed = element({ testId: 'login-submit-v2', accessibleName: 'Log in', text: 'Log in' });
    const [best] = scoreCandidates({
      brokenLocator: { strategy: 'testId', value: 'login-submit' },
      fingerprint: {
        tagName: 'button', ariaRole: 'button', accessibleName: 'Sign in',
        testId: 'login-submit', type: 'submit', domPath: 'html/body/main/form/button',
        bounding: { x: 40, y: 430, width: 84, height: 41 }
      },
      candidates: [renamed]
    });

    expect(best).toBeDefined();
    expect(best!.score).toBeGreaterThanOrEqual(80);
    expect(best!.descriptor.strategy).toBe('testId');
    expect(best!.descriptor.value).toBe('login-submit-v2');
  });

  test('an unambiguous match is rated above the same match among look-alikes', () => {
    const fingerprint = {
      tagName: 'button', ariaRole: 'button', accessibleName: 'Sign in',
      testId: 'login-submit', type: 'submit', domPath: 'html/body/main/form/button'
    };
    const renamed = element({ testId: 'login-submit-v2', accessibleName: 'Log in', text: 'Log in' });

    const alone = scoreCandidates({
      brokenLocator: { strategy: 'testId', value: 'login-submit' },
      fingerprint, candidates: [renamed]
    })[0]!;

    const amongTwins = scoreCandidates({
      brokenLocator: { strategy: 'testId', value: 'login-submit' },
      fingerprint,
      candidates: [
        renamed,
        element({ testId: 'login-submit-v3', accessibleName: 'Log in', text: 'Log in' })
      ]
    })[0]!;

    expect(alone.score).toBeGreaterThan(amongTwins.score);
    expect(amongTwins.breakdown.uniqueness).toBeLessThan(0);
  });

  test('a completely different control is not offered as a replacement', () => {
    const results = scoreCandidates({
      brokenLocator: { strategy: 'testId', value: 'login-submit' },
      fingerprint: {
        tagName: 'button', ariaRole: 'button', accessibleName: 'Sign in',
        testId: 'login-submit', type: 'submit', domPath: 'html/body/main/form/button'
      },
      candidates: [element({
        kind: 'link', tagName: 'a', ariaRole: 'link', accessibleName: 'Privacy policy',
        text: 'Privacy policy', testId: 'privacy-link', type: null,
        domPath: 'html/body/footer/a', bounding: { x: 600, y: 900, width: 90, height: 18 }
      })]
    });

    const best = results[0];
    expect(best === undefined || best.score < 60).toBe(true);
  });

  test('invisible elements without a test id are not candidates', () => {
    const results = scoreCandidates({
      brokenLocator: { strategy: 'testId', value: 'login-submit' },
      candidates: [element({ isVisible: false, testId: null })]
    });
    expect(results).toHaveLength(0);
  });

  test('an input of an incompatible type is never substituted', () => {
    const results = scoreCandidates({
      brokenLocator: { strategy: 'label', value: 'Password' },
      fingerprint: { tagName: 'input', ariaRole: 'textbox', type: 'password', label: 'Password' },
      candidates: [element({
        kind: 'checkbox', tagName: 'input', ariaRole: 'checkbox', type: 'checkbox',
        label: 'Password', accessibleName: 'Password', testId: null
      })]
    });
    expect(results).toHaveLength(0);
  });

  test('ranking is stable across repeated runs', () => {
    const candidates = [
      element({ testId: 'a', domPath: 'html/body/a' }),
      element({ testId: 'b', domPath: 'html/body/b' })
    ];
    const first = scoreCandidates({ brokenLocator: { strategy: 'testId', value: 'a' }, candidates })
      .map(c => c.descriptor.value);
    const second = scoreCandidates({ brokenLocator: { strategy: 'testId', value: 'a' }, candidates })
      .map(c => c.descriptor.value);
    expect(first).toEqual(second);
  });
});
