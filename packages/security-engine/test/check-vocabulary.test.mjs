/**
 * The engine's check list against the platform's, read from source.
 *
 * ## Why this exists when a golden test already covers it
 *
 * SECPL-027 compares the two lists and is correct. It also needs the platform running to ask
 * it for its vocabulary, so it runs when somebody runs the whole product verification and not
 * otherwise. Two checks were added to the C# side and not here, and the guard that exists to
 * catch exactly that said nothing for as long as nobody ran it.
 *
 * A guard that only fires in the expensive suite is a guard against the wrong thing. This one
 * reads the C# constants off disk, needs no database, no API and no browser, and runs with
 * every `npm test` in this package — so the drift is caught by the cheapest suite that could
 * possibly catch it.
 *
 * It does not replace SECPL-027: that test proves the *running* platform serves what its
 * source declares, which a file read cannot establish.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CHECKS, CHECKS_REQUIRING_BROWSER } from '../../../verification/golden-tests/security/scenarios.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, '../../../apps/api/src/QaNxt.Application/Security/SecurityChecks.cs');

/** The `public const string Name = "value";` declarations, by C# identifier. */
function declaredConstants(source) {
  const found = new Map();
  for (const match of source.matchAll(/public const string (\w+)\s*=\s*"([^"]+)"/g)) {
    found.set(match[1], match[2]);
  }
  return found;
}

/** The members of a `public static IReadOnly... Name { get; } = new...{ A, B };` list. */
function listMembers(source, property, constants) {
  const body = new RegExp(`${property} \\{ get; \\} = new[^{]*\\{([^}]*)\\}`, 's').exec(source);
  assert.ok(body, `could not find the ${property} list in SecurityChecks.cs`);
  return [...body[1].matchAll(/\b([A-Z]\w+)\b/g)]
    .map(m => constants.get(m[1]))
    .filter(value => value !== undefined);
}

test('every check the platform declares is in its own canonical list', () => {
  const source = readFileSync(SOURCE, 'utf8');
  const constants = declaredConstants(source);
  const all = new Set(listMembers(source, 'All', constants));

  assert.ok(constants.size > 0, 'no check constants were read from the C# source');
  const missing = [...constants.values()].filter(check => !all.has(check));
  assert.deepEqual(missing, [],
    `declared in SecurityChecks.cs but absent from All: ${missing.join(', ')}. `
    + 'The selector drops a check it cannot find there, so an open finding naming it stops '
    + 'being re-tested.');
});

test('the engine names every check the platform does, and no others', () => {
  const source = readFileSync(SOURCE, 'utf8');
  const constants = declaredConstants(source);
  const platform = listMembers(source, 'All', constants);

  const onlyPlatform = platform.filter(c => !CHECKS.includes(c));
  const onlyEngine = CHECKS.filter(c => !platform.includes(c));

  assert.deepEqual(onlyPlatform, [], `only in the platform: ${onlyPlatform.join(', ')}`);
  assert.deepEqual(onlyEngine, [], `only in the engine: ${onlyEngine.join(', ')}`);
});

test('the two sides agree on which checks need a browser', () => {
  const source = readFileSync(SOURCE, 'utf8');
  const constants = declaredConstants(source);
  const platform = listMembers(source, 'RequiresBrowser', constants).slice().sort();

  assert.deepEqual(platform, CHECKS_REQUIRING_BROWSER.slice().sort());
});

test('no check is listed twice on either side', () => {
  const source = readFileSync(SOURCE, 'utf8');
  const platform = listMembers(source, 'All', declaredConstants(source));

  assert.equal(new Set(platform).size, platform.length, 'the platform lists a check twice');
  assert.equal(new Set(CHECKS).size, CHECKS.length, 'the engine lists a check twice');
});
