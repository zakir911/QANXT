import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  BROWSER_ACTION_TYPES, LOCATOR_STRATEGIES, EXECUTION_STATUSES, FAILURE_CATEGORIES,
  ELEMENT_KINDS, PAGE_KINDS, describeLocator, locatorStability, isReference,
  isRecordedJourney
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const enumsFile = resolve(here, '../../../apps/api/src/Aira.Domain/Enums/Enums.cs');
const locatorFile = resolve(here, '../../../apps/api/src/Aira.Application/Contracts/Locator.cs');

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

test('FailureCategory matches the server enum', () => {
  assert.deepEqual([...FAILURE_CATEGORIES].sort(), membersOf('FailureCategory').map(camel).sort());
});

test('ElementKind matches the server enum', () => {
  assert.deepEqual([...ELEMENT_KINDS].sort(), membersOf('ElementKind').map(camel).sort());
});

test('PageKind matches the server enum', () => {
  assert.deepEqual([...PAGE_KINDS].sort(), membersOf('PageKind').map(camel).sort());
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
