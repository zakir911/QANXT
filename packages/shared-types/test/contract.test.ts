import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  API_AUTH_MODES, ASSERTION_TYPES,
  BROWSER_ACTION_TYPES, BROWSER_TYPES, LOCATOR_STRATEGIES, EXECUTION_STATUSES,
  FAILURE_CATEGORIES, RUN_TRIGGERS, TEST_CASE_KINDS,
  ELEMENT_KINDS, PAGE_KINDS, describeLocator, locatorStability, isReference,
  isRecordedJourney, readJsonPath, statusMatches, describeJsonValue
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const enumsFile = resolve(here, '../../../apps/api/src/QaNxt.Domain/Enums/Enums.cs');
const locatorFile = resolve(here, '../../../apps/api/src/QaNxt.Application/Contracts/Locator.cs');

/**
 * The control plane and the execution plane are written in different languages and
 * exchange these enums as strings. This test reads the C# source and asserts the
 * TypeScript unions cover exactly the same members, so a rename on either side
 * fails the build instead of failing in production as an unrecognised value.
 */
function membersOf(enumName: string, file: string = enumsFile): string[] {
  const source = readFileSync(file, 'utf8');
  // Enums are declared both multi-line and on a single line, so match to the first
  // closing brace rather than assuming a newline precedes it.
  const match = new RegExp(`enum ${enumName}\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(match, `enum ${enumName} not found in ${file}`);
  return match[1]
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, '').replace(/\/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => part.split('=')[0].trim())
    .filter(name => /^[A-Za-z][A-Za-z0-9]*$/.test(name));
}

const camel = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

test('BrowserActionType matches the server enum', () => {
  assert.deepEqual([...BROWSER_ACTION_TYPES].sort(), membersOf('BrowserActionType').map(camel).sort());
});

test('LocatorStrategy matches the server enum', () => {
  assert.deepEqual([...LOCATOR_STRATEGIES].sort(), membersOf('LocatorStrategy', locatorFile).map(camel).sort());
});

test('ExecutionStatus matches the server enum', () => {
  assert.deepEqual([...EXECUTION_STATUSES].sort(), membersOf('ExecutionStatus').map(camel).sort());
});

test('RunTrigger matches the server enum', () => {
  assert.deepEqual([...RUN_TRIGGERS].sort(), membersOf('RunTrigger').map(camel).sort());
});

test('BrowserType matches the server enum', () => {
  assert.deepEqual([...BROWSER_TYPES].sort(), membersOf('BrowserType').map(camel).sort());
});

test('FailureCategory matches the server enum', () => {
  assert.deepEqual([...FAILURE_CATEGORIES].sort(), membersOf('FailureCategory').map(camel).sort());
});

test('ElementKind matches the server enum', () => {
  assert.deepEqual([...ELEMENT_KINDS].sort(), membersOf('ElementKind').map(camel).sort());
});

test('PageKind matches the server enum', () => {
  assert.deepEqual([...PAGE_KINDS].sort(), membersOf('PageKind').map(camel).sort());
});

test('AssertionType matches the server enum', () => {
  // Dead assertion types are not a theoretical risk: BUG-0017 shipped two that the
  // executor silently turned into "visible". Parity is checked so that adding one on
  // either side without the other fails here instead of in a test report.
  assert.deepEqual([...ASSERTION_TYPES].sort(), membersOf('AssertionType').map(camel).sort());
});

test('TestCaseKind matches the server enum', () => {
  assert.deepEqual([...TEST_CASE_KINDS].sort(), membersOf('TestCaseKind').map(camel).sort());
});

test('ApiAuthMode matches the server enum', () => {
  assert.deepEqual([...API_AUTH_MODES].sort(), membersOf('ApiAuthMode').map(camel).sort());
});

test('readJsonPath walks objects, arrays and indexes, and reports absence', () => {
  const body = { data: { accounts: [{ id: 'a-1', balance: 1250.5 }, { id: 'a-2' }] }, ok: true };

  assert.deepEqual(readJsonPath(body, 'data.accounts[0].id'), { found: true, value: 'a-1' });
  assert.deepEqual(readJsonPath(body, '$.data.accounts.1.id'), { found: true, value: 'a-2' });
  assert.deepEqual(readJsonPath(body, 'ok'), { found: true, value: true });
  assert.deepEqual(readJsonPath(body, ''), { found: true, value: body });

  // Absent is distinguished from present-and-null, because "the field is gone" and "the
  // field is empty" are different findings about an API.
  assert.equal(readJsonPath(body, 'data.accounts[9].id').found, false);
  assert.equal(readJsonPath(body, 'data.missing').found, false);
  assert.equal(readJsonPath({ a: null }, 'a').found, true);
  assert.equal(readJsonPath({ a: null }, 'a.b').found, false);
});

test('readJsonPath does not reach inherited properties', () => {
  // A generated path must not be able to read toString or __proto__ off a body and
  // report it as data the API returned.
  assert.equal(readJsonPath({}, 'toString').found, false);
  assert.equal(readJsonPath({}, 'constructor').found, false);
});

test('statusMatches understands codes, ranges and families', () => {
  assert.equal(statusMatches('200', 200), true);
  assert.equal(statusMatches('200', 201), false);
  assert.equal(statusMatches('200,201,204', 204), true);
  assert.equal(statusMatches('200-204', 203), true);
  assert.equal(statusMatches('200-204', 205), false);
  assert.equal(statusMatches('2xx', 299), true);
  assert.equal(statusMatches('2xx', 300), false);
  assert.equal(statusMatches('4xx,5xx', 503), true);
  assert.equal(statusMatches('', 200), false);
});

test('describeJsonValue renders values a failure message can print', () => {
  assert.equal(describeJsonValue(undefined), '(absent)');
  assert.equal(describeJsonValue(null), 'null');
  assert.equal(describeJsonValue('abc'), 'abc');
  assert.equal(describeJsonValue({ a: 1 }), '{"a":1}');
  assert.equal(describeJsonValue('x'.repeat(200)).length, 121);
});

test('locator stability ranks semantic strategies above structural ones', () => {
  assert.ok(locatorStability({ strategy: 'testId', value: 'x' })
    > locatorStability({ strategy: 'role', value: 'button', name: 'Save' }));
  assert.ok(locatorStability({ strategy: 'css', value: '.btn' })
    > locatorStability({ strategy: 'xpath', value: '//div[2]' }));
  assert.ok(locatorStability({ strategy: 'role', value: 'button' })
    < locatorStability({ strategy: 'role', value: 'button', name: 'Save' }));
});

test('describeLocator renders the forms used in reports', () => {
  assert.equal(describeLocator({ strategy: 'role', value: 'button', name: 'Login' }), 'role=button name="Login"');
  assert.equal(describeLocator({ strategy: 'testId', value: 'submit' }), 'testId="submit"');
});

test('secret and data references are recognised, literals are not', () => {
  assert.equal(isReference('${secret:bank_password}'), true);
  assert.equal(isReference('${data:accountNumber}'), true);
  assert.equal(isReference('literal-value'), false);
  assert.equal(isReference(undefined), false);
});

test('recorded journeys are validated before import', () => {
  assert.equal(isRecordedJourney({ schemaVersion: 1, name: 'x', startUrl: 'http://a', steps: [] }), true);
  assert.equal(isRecordedJourney({ schemaVersion: 2, name: 'x', startUrl: 'http://a', steps: [] }), false);
  assert.equal(isRecordedJourney(null), false);
});
