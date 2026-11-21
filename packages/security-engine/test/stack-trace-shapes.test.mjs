import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STACK_TRACE_PATTERN } from '../src/checks-passive.mjs';

/**
 * The stack-trace detector, against the runtimes applications are actually written in.
 *
 * It matched one spelling: `at Namespace.Method(args) in /path/File.cs:line 42`, which is
 * .NET and nothing else. Measured: an order API returning a Node stack with absolute paths
 * to an unparseable id, and the same leak in a freight application's API, both invisible
 * while this knew one format.
 *
 * The real pattern is imported, not re-declared: a test carrying its own copy would not
 * have caught the defect this replaces.
 */
const pattern = STACK_TRACE_PATTERN;

const matches = (body) => pattern.test(body);

test('a Node stack trace is recognised', () => {
  assert.ok(matches([
    'TypeError: Cannot read properties of null (reading \'trim\')',
    '    at sendSupportMessage (/srv/app/handlers.js:42:17)',
    '    at processTicksAndRejections (node:internal/process/task_queues:95:5)'
  ].join('\n')));
});

test('a Node stack with no named function is recognised', () => {
  assert.ok(matches('Error: boom\n    at /home/user/app/server.mjs:70:15'));
});

test('a stack of nothing but node internals is recognised', () => {
  assert.ok(matches('Error\n    at node:internal/url (node:internal/url:818:25)'
    + '\n    at parserOnIncoming (node:_http_server:1186:12)'));
});

test('a .NET stack trace is still recognised', () => {
  assert.ok(matches('   at Acme.Orders.Read(Guid id) in /src/Orders.cs:line 42'));
});

test('a Java stack trace is recognised', () => {
  assert.ok(matches('java.lang.NullPointerException\n\tat com.acme.Orders.read(Orders.java:42)'));
});

test('a Python traceback is recognised', () => {
  assert.ok(matches('Traceback (most recent call last):\n  File "/srv/app.py", line 42, in read\n    raise'));
});

test('a PHP frame list is recognised', () => {
  assert.ok(matches('Fatal error: Uncaught TypeError\nStack trace:\n#0 /var/www/app.php(42): read()'));
});

test('a Ruby backtrace is recognised', () => {
  assert.ok(matches("/app/controllers/orders.rb:42:in `show'"));
});

/** The reason the alternatives are anchored on line and column numbers rather than on the
 *  word "at": an application is allowed to talk about itself. */
test('ordinary prose is not a stack trace', () => {
  assert.ok(!matches('The order could not be read. Try again at a later time.'));
  assert.ok(!matches('Arrived at the depot at 09:42 on 2026-04-12.'));
  assert.ok(!matches('{"error":"not_found","detail":"No order with that id"}'));
  assert.ok(!matches('See the guide at /docs/orders.html for the id format.'));
});
