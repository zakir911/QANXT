/**
 * Injection: SQL, NoSQL, command and template.
 *
 * Every check here is detection only. Nothing extracts data, nothing executes a command,
 * nothing reads a file, nothing writes anything. The probes are the smallest ones that
 * produce a distinguishable answer:
 *
 *   SQL       an unbalanced quote, and a tautology compared against a baseline count
 *   NoSQL     an operator object where a string belongs
 *   command   one metacharacter, looking for a shell-shaped error
 *   template  {{7*7}}, looking for 49
 *
 * Two of those — the tautology and the arithmetic marker — are comparisons, not payloads.
 * A tautology is only evidence if the same query without it returned fewer rows, and 49 is
 * only evidence if 49 was not already in the response. Both baselines are taken first, and
 * a check that cannot take its baseline reports inconclusive rather than guessing.
 *
 * `' OR '1'='1` is the one probe here that could, against a real application, return rows
 * the caller is not entitled to. It is sent against a single named parameter, once, and
 * the finding records only the row *count*, never the rows.
 */
import { SECURITY_RISK } from './scope-guard.mjs';
import { SeverityFactors, confidenceFrom } from './severity.mjs';

/** Error signatures that indicate a query reached a database engine and broke. */
const SQL_ERRORS = [
  /SQLSTATE\[/i, /syntax error/i, /unclosed quotation mark/i, /unterminated quoted string/i,
  /ORA-\d{5}/, /PG::SyntaxError/i, /SQLiteException/i, /You have an error in your SQL syntax/i,
  /mysql_fetch/i, /Npgsql\./i
];

/** Error signatures that indicate the value reached a shell. */
const SHELL_ERRORS = [
  /\/bin\/(sh|bash):/i, /command not found/i, /not recognized as an internal or external command/i,
  /sh: \d+:/i, /Syntax error: .* unexpected/i
];

const matches = (text, patterns) => patterns.find(p => p.test(text ?? ''));

const countRows = body => {
  if (body === null || typeof body !== 'object') return null;
  if (typeof body.matched === 'number') return body.matched;
  for (const value of Object.values(body)) if (Array.isArray(value)) return value.length;
  return null;
};

/**
 * SQL injection, by two independent indicators.
 *
 * An error signature alone is Medium confidence — plenty of applications return a database
 * error for input they simply did not expect. A tautology that widens the result set is the
 * behavioural indicator, and the two together are what makes the finding High.
 */
export async function checkSqlInjection(scanner, { baseUrl, path, parameter, benign = 'Synthetic Widget', testId = 'SECA-SQLI' }) {
  const probe = async (value, id, note) => scanner.request({
    url: `${baseUrl}${path}?${parameter}=${encodeURIComponent(value)}`,
    risk: SECURITY_RISK.ACTIVE, testId: `${testId}:${id}`, as: 'unauthenticated', note
  });

  const baseline = await probe(benign, 'baseline', 'a benign value, to establish what a normal answer looks like');
  if (!baseline.allowed) return { skipped: true, decision: baseline.decision, findings: [] };

  const quote = await probe(`${benign}'`, 'unbalanced-quote', 'one unbalanced quote');
  if (!quote.allowed) return { skipped: true, decision: quote.decision, findings: [] };

  const tautology = await probe(`' OR '1'='1`, 'tautology', 'a tautology, to see whether the result set widens');
  if (!tautology.allowed) return { skipped: true, decision: tautology.decision, findings: [] };

  const errorSignature = matches(quote.responseText, SQL_ERRORS);
  const baseRows = countRows(baseline.responseBody);
  const tautRows = countRows(tautology.responseBody);
  const widened = baseRows !== null && tautRows !== null && tautRows > baseRows;

  if (!errorSignature && !widened) {
    return { skipped: false, findings: [], ok: true,
             detail: `unbalanced quote answered ${quote.status} with no database error signature; `
               + `tautology returned ${tautRows ?? '?'} row(s) against a baseline of ${baseRows ?? '?'}` };
  }

  const indicators = [
    errorSignature ? `a database error matching ${errorSignature}` : null,
    widened ? `the result set widening from ${baseRows} to ${tautRows} row(s)` : null
  ].filter(Boolean);

  return {
    skipped: false,
    findings: [{
      category: 'SqlInjection',
      title: `'${parameter}' is concatenated into a SQL query`,
      endpoint: path, httpMethod: 'GET', parameter, observedAsRole: 'unauthenticated',
      description: `Two probes against '${parameter}': ${indicators.join(', and ')}. No data was extracted `
        + 'and no second statement was attempted — only the row count is recorded, never the rows.',
      impact: 'An attacker controls part of a database query, which in the general case means reading, '
        + 'changing or destroying anything the application\'s database account can reach.',
      remediation: 'Use parameterised queries. Escaping the input is not a substitute.',
      cwe: 'CWE-89', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A03:2021',
      severityFactors: new SeverityFactors('trivial', 'severe', 'none', 'credentials', 'public'),
      confidence: confidenceFrom({
        reproduced: true, corroborated: indicators.length > 1, unambiguous: indicators.length > 1
      }),
      exchanges: [baseline, quote, tautology],
      coverageNote: 'Detection only. No extraction, no stacked statement, no time-based probe, no attempt '
        + 'to determine the schema.'
    }]
  };
}

/** NoSQL injection: an operator object accepted where a string belongs. */
export async function checkNoSqlInjection(scanner, { baseUrl, path, field = 'password', companion = { username: 'alice' }, testId = 'SECA-NOSQLI' }) {
  const post = async (value, id, note) => scanner.request({
    url: `${baseUrl}${path}`, method: 'POST', risk: SECURITY_RISK.STATE_CHANGING,
    headers: { 'content-type': 'application/json' }, body: { ...companion, [field]: value },
    as: 'unauthenticated', testId: `${testId}:${id}`, note
  });

  const baseline = await post('aira-deliberately-wrong-value', 'baseline', 'an ordinary string value');
  if (!baseline.allowed) return { skipped: true, decision: baseline.decision, findings: [] };

  const operator = await post({ $ne: null }, 'operator', 'a query operator where a string belongs');
  if (!operator.allowed) return { skipped: true, decision: operator.decision, findings: [] };

  // The finding is that the operator changed the outcome in the caller's favour. An
  // application that answers 400 to a non-string is doing exactly the right thing.
  const baselineFailed = baseline.status >= 400;
  const operatorSucceeded = operator.status >= 200 && operator.status < 300;

  if (!(baselineFailed && operatorSucceeded)) {
    return { skipped: false, findings: [], ok: true,
             detail: `string value ${baseline.status}, operator object ${operator.status}` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'NoSqlInjection',
      title: `'${field}' accepts a query operator in place of a value`,
      endpoint: path, httpMethod: 'POST', parameter: field, observedAsRole: 'unauthenticated',
      description: `A string value was refused (${baseline.status}) while an operator object was accepted `
        + `(${operator.status}). The request body reaches the query unchecked, so a caller can supply a `
        + 'condition rather than a value.',
      impact: 'Authentication and filtering can be bypassed by sending a condition that is always true.',
      remediation: 'Validate the type of every field before it reaches the query, and reject objects where '
        + 'a scalar is expected.',
      cwe: 'CWE-943', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A03:2021',
      // 'straightforward' rather than 'trivial': the attacker has to work out that the field
      // reaches a query untyped and craft an operator for the engine behind it. That is a
      // short step, not a free one, and the difference is what keeps this High rather than
      // Critical.
      severityFactors: new SeverityFactors('straightforward', 'serious', 'none', 'credentials', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [baseline, operator]
    }]
  };
}

/**
 * Command injection, by error signature only.
 *
 * The probe is a single metacharacter appended to an otherwise valid value. It does not
 * name a command, does not chain one, and does not attempt a callback or a sleep. What it
 * looks for is the application reporting a shell error, which means the value reached a
 * shell — the finding, without anything having been run.
 */
export async function checkCommandInjection(scanner, { baseUrl, path, parameter, benign = 'localhost', testId = 'SECA-CMDI' }) {
  const probe = async (value, id, note) => scanner.request({
    url: `${baseUrl}${path}?${parameter}=${encodeURIComponent(value)}`,
    risk: SECURITY_RISK.ACTIVE, testId: `${testId}:${id}`, as: 'unauthenticated', note
  });

  const baseline = await probe(benign, 'baseline', 'a valid value');
  if (!baseline.allowed) return { skipped: true, decision: baseline.decision, findings: [] };

  const metacharacter = await probe(`${benign};`, 'metacharacter',
    'one shell metacharacter, naming no command');
  if (!metacharacter.allowed) return { skipped: true, decision: metacharacter.decision, findings: [] };

  const signature = matches(metacharacter.responseText, SHELL_ERRORS);
  if (!signature) {
    return { skipped: false, findings: [], ok: true,
             detail: `metacharacter answered ${metacharacter.status} with no shell error signature` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'CommandInjection',
      title: `'${parameter}' reaches a shell`,
      endpoint: path, httpMethod: 'GET', parameter, observedAsRole: 'unauthenticated',
      description: `Appending a single ';' to a valid value produced a response matching ${signature}, `
        + 'which is a shell reporting that it could not run what it was given. The probe named no command '
        + 'and nothing was executed: the finding is that the value reached a shell at all.',
      impact: 'An attacker who controls part of a shell command controls the process that runs it.',
      remediation: 'Do not build shell commands from input. Use an API that takes an argument list, and '
        + 'validate against an allowlist.',
      cwe: 'CWE-78', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A03:2021',
      severityFactors: new SeverityFactors('trivial', 'severe', 'none', 'credentials', 'public'),
      confidence: confidenceFrom({ reproduced: false, corroborated: true, unambiguous: true }),
      exchanges: [baseline, metacharacter],
      coverageNote: 'Detection only. No command was named, chained, timed or called back.'
    }]
  };
}

/**
 * Server-side template injection, by arithmetic that could not have been there already.
 *
 * `{{7*7}}` → `49`. The baseline exists to rule out an application that happens to contain
 * 49 for its own reasons, which would otherwise be a false positive on an application that
 * does nothing wrong.
 */
export async function checkTemplateInjection(scanner, { baseUrl, path, parameter, testId = 'SECA-SSTI' }) {
  const probe = async (value, id, note) => scanner.request({
    url: `${baseUrl}${path}?${parameter}=${encodeURIComponent(value)}`,
    risk: SECURITY_RISK.ACTIVE, testId: `${testId}:${id}`, as: 'unauthenticated', note
  });

  const baseline = await probe('aira-template-baseline', 'baseline',
    'a plain value, to establish that 49 is not already in the response');
  if (!baseline.allowed) return { skipped: true, decision: baseline.decision, findings: [] };

  if ((baseline.responseText ?? '').includes('49')) {
    return { skipped: false, findings: [], inconclusive: true,
             reason: 'The response already contains 49 for reasons unrelated to the probe, so the '
               + 'arithmetic marker cannot distinguish evaluation from coincidence here.' };
  }

  const attempts = [
    { id: 'handlebars', value: '{{7*7}}' },
    { id: 'erb-jinja', value: '${7*7}' },
    { id: 'razor-angular', value: '{{ 7 * 7 }}' }
  ];

  const exchanges = [baseline];
  const evaluated = [];
  for (const attempt of attempts) {
    const result = await probe(attempt.value, attempt.id, `arithmetic marker ${attempt.value}`);
    if (!result.allowed) return { skipped: true, decision: result.decision, findings: [] };
    exchanges.push(result);
    if ((result.responseText ?? '').includes('49')) evaluated.push(attempt);
  }

  if (evaluated.length === 0) {
    return { skipped: false, findings: [], ok: true,
             detail: `${attempts.length} arithmetic marker(s) returned unevaluated` };
  }

  return {
    skipped: false,
    findings: [{
      category: 'TemplateInjection',
      title: `'${parameter}' is evaluated as a template`,
      endpoint: path, httpMethod: 'GET', parameter, observedAsRole: 'unauthenticated',
      description: `${evaluated.map(a => a.value).join(' and ')} came back as 49, and a plain value in the `
        + 'same parameter did not produce 49. The input is being evaluated rather than rendered.',
      impact: 'Template evaluation of input commonly leads to reading server-side state and, depending on '
        + 'the engine, to running code.',
      remediation: 'Never compile input as a template. Pass it as data to a fixed template instead.',
      cwe: 'CWE-1336', cweConfidence: 'confirmed',
      owaspApiCategory: 'API8:2023', owaspWebCategory: 'A03:2021',
      // 'straightforward': what follows the arithmetic marker depends entirely on which
      // engine is behind it, and reaching anything worth having takes engine-specific work.
      severityFactors: new SeverityFactors('straightforward', 'serious', 'none', 'credentials', 'public'),
      confidence: confidenceFrom({ reproduced: true, corroborated: true, unambiguous: true }),
      exchanges,
      coverageNote: 'Arithmetic only. No engine-specific object traversal or code execution was attempted.'
    }]
  };
}
