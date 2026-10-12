/**
 * The golden form lab's forms, declared once.
 *
 * The server renders and validates from these declarations, and the ground truth the
 * verification suite measures against is generated from them too. A lab whose ground truth
 * is a hand-maintained JSON file next to a hand-written server drifts: somebody changes a
 * rule in one and not the other, and from then on the platform is being marked against a
 * description of an application that does not exist.
 *
 * Every deliberate defect is declared on the form it lives in, with the testing categories
 * expected to catch it. A defect with no category that should catch it would be a defect
 * the lab cannot use to prove anything.
 *
 * Field `rules` are the server's rules as a person would state them. `attrs` are what the
 * HTML declares — the only part of a rule a crawler can see. Where the two differ, the
 * difference is the point: a rule that exists only on the server cannot be discovered, and
 * the platform must report it as a gap rather than invent it.
 */

const COUNTRIES = ['United Kingdom', 'United States', 'Canada', 'Germany'];
export const REGIONS = {
  'United Kingdom': ['England', 'Scotland', 'Wales', 'Northern Ireland'],
  'United States': ['California', 'New York', 'Texas'],
  Canada: ['Ontario', 'Quebec', 'British Columbia'],
  Germany: ['Bavaria', 'Berlin', 'Hamburg']
};

export const FORMS = [
  {
    id: 'simple-form', route: '/simple-form', title: 'Simple form',
    purpose: 'One required field with native browser validation.',
    native: true,
    fields: [
      { name: 'name', label: 'Your name', type: 'text', required: true, attrs: { autocomplete: 'name' } }
    ],
    submitLabel: 'Send',
    defects: []
  },
  {
    id: 'registration', route: '/registration', title: 'Create an account',
    purpose: 'Registration with a password confirmation and terms.',
    fields: [
      { name: 'fullName', label: 'Full name', type: 'text', required: true, attrs: { minlength: 2, maxlength: 60, autocomplete: 'name' } },
      { name: 'email', label: 'Email address', type: 'email', required: true, attrs: { autocomplete: 'email' } },
      { name: 'password', label: 'Password', type: 'password', required: true, attrs: { minlength: 8, autocomplete: 'new-password' } },
      { name: 'confirmPassword', label: 'Confirm password', type: 'password', required: true, attrs: { minlength: 8, autocomplete: 'new-password' } },
      { name: 'terms', label: 'I accept the terms and conditions', type: 'checkbox', required: true }
    ],
    crossRules: [
      { id: 'password-confirmation', fields: ['password', 'confirmPassword'], kind: 'equals', message: 'The passwords do not match.' }
    ],
    submitLabel: 'Create account',
    defects: [
      { id: 'FL-D01', description: 'The server accepts a confirmation that does not match the password.', detectedBy: ['crossField'], skipsRule: 'password-confirmation' }
    ]
  },
  {
    id: 'login', route: '/login', title: 'Sign in',
    purpose: 'Credential form with native validation, a generic error and lock-out after five failures.',
    native: true,
    fields: [
      { name: 'username', label: 'Username', type: 'text', required: true, attrs: { autocomplete: 'username' } },
      { name: 'password', label: 'Password', type: 'password', required: true, attrs: { autocomplete: 'current-password' } }
    ],
    submitLabel: 'Sign in',
    credentials: { username: 'demo', password: 'demo-pass' },
    defects: []
  },
  {
    id: 'checkout', route: '/checkout', title: 'Checkout',
    purpose: 'Order form whose submit control disables itself, so a double click places one order.',
    guardDuplicate: true,
    latencyMs: 600,
    fields: [
      { name: 'fullName', label: 'Name on order', type: 'text', required: true, attrs: { maxlength: 80, autocomplete: 'name' } },
      { name: 'email', label: 'Receipt email', type: 'email', required: true, attrs: { autocomplete: 'email' } },
      { name: 'quantity', label: 'Quantity', type: 'number', required: true, attrs: { min: 1, max: 10, step: 1 } },
      { name: 'shipping', label: 'Delivery', type: 'radio', required: true, options: ['Standard', 'Express'] },
      { name: 'giftWrap', label: 'Gift wrap', type: 'checkbox' },
      { name: 'notes', label: 'Delivery notes', type: 'textarea', attrs: { maxlength: 200 } }
    ],
    submitLabel: 'Place order',
    defects: []
  },
  {
    id: 'payment', route: '/payment', title: 'Make a payment',
    purpose: 'Card payment. Deliberately missing its anti-forgery token.',
    csrf: false,
    fields: [
      { name: 'cardholder', label: 'Cardholder name', type: 'text', required: true, attrs: { autocomplete: 'cc-name', maxlength: 60 } },
      { name: 'cardNumber', label: 'Card number', type: 'text', required: true, attrs: { pattern: '[0-9]{16}', inputmode: 'numeric', autocomplete: 'cc-number', maxlength: 16 } },
      { name: 'expiry', label: 'Expiry month', type: 'month', required: true, attrs: { min: '2026-01', max: '2036-12' } },
      { name: 'cvv', label: 'Security code', type: 'text', required: true, attrs: { pattern: '[0-9]{3,4}', inputmode: 'numeric', autocomplete: 'cc-csc', maxlength: 4 } },
      { name: 'amount', label: 'Amount', type: 'number', required: true, attrs: { min: 1, max: 5000, step: 0.01 } }
    ],
    submitLabel: 'Pay now',
    defects: [
      { id: 'FL-D10', description: 'The payment form carries no anti-forgery token.', detectedBy: ['security'] }
    ]
  },
  {
    id: 'profile', route: '/profile', title: 'Edit profile',
    purpose: 'Profile with a switch, a counted bio and optional fields.',
    fields: [
      { name: 'displayName', label: 'Display name', type: 'text', required: true, attrs: { maxlength: 40 } },
      { name: 'email', label: 'Email', type: 'email', required: true },
      { name: 'bio', label: 'Bio', type: 'textarea', attrs: { maxlength: 160 } },
      { name: 'website', label: 'Website', type: 'url' },
      { name: 'phone', label: 'Phone', type: 'tel', attrs: { pattern: '[0-9+ ]{7,15}', autocomplete: 'tel' } },
      { name: 'newsletter', label: 'Email me the newsletter', type: 'switch' }
    ],
    submitLabel: 'Save profile',
    defects: [
      { id: 'FL-D08', description: 'A display name of only spaces is accepted.', detectedBy: ['negative', 'validation'], noTrim: 'displayName' }
    ]
  },
  {
    id: 'address', route: '/address', title: 'Delivery address',
    purpose: 'Address form laid out at a fixed width, so it overflows a phone screen.',
    fixedWidth: true,
    fields: [
      { name: 'line1', label: 'Address line 1', type: 'text', required: true, attrs: { maxlength: 80, autocomplete: 'address-line1' } },
      { name: 'line2', label: 'Address line 2', type: 'text', attrs: { maxlength: 80, autocomplete: 'address-line2' } },
      { name: 'city', label: 'Town or city', type: 'text', required: true, attrs: { maxlength: 50 } },
      { name: 'postcode', label: 'Postcode', type: 'text', required: true, attrs: { pattern: '[A-Za-z0-9 ]{3,10}', autocomplete: 'postal-code' } },
      { name: 'country', label: 'Country', type: 'select', required: true, options: COUNTRIES }
    ],
    submitLabel: 'Save address',
    defects: [
      { id: 'FL-D15', description: 'The form is 900px wide and scrolls horizontally on a phone.', detectedBy: ['responsive'] }
    ]
  },
  {
    id: 'search', route: '/search', title: 'Search',
    purpose: 'A GET search whose results page reflects the query without escaping it.',
    method: 'get', action: '/search/results', csrf: false,
    fields: [
      { name: 'q', label: 'Search for', type: 'search' },
      { name: 'category', label: 'Category', type: 'select', options: ['All', 'Accounts', 'Cards', 'Loans'] }
    ],
    submitLabel: 'Search',
    defects: [
      { id: 'FL-D06', description: 'The results page writes the query into the page without escaping it (reflected markup injection).', detectedBy: ['security'] }
    ]
  },
  {
    id: 'multi-step', route: '/multi-step', title: 'Loan application',
    purpose: 'A three-step wizard. Previous clears the first step.',
    multiStep: true,
    fields: [
      { name: 'applicant', label: 'Applicant name', type: 'text', required: true, step: 1, attrs: { maxlength: 60 } },
      { name: 'email', label: 'Contact email', type: 'email', required: true, step: 1 },
      { name: 'loanAmount', label: 'Loan amount', type: 'number', required: true, step: 2, attrs: { min: 1000, max: 50000, step: 100 } },
      { name: 'termMonths', label: 'Term', type: 'select', required: true, step: 2, options: ['12', '24', '36', '48'] },
      { name: 'agree', label: 'I confirm these details are correct', type: 'checkbox', required: true, step: 3 }
    ],
    submitLabel: 'Submit application',
    defects: [
      { id: 'FL-D11', description: 'Going back from step 2 empties the fields of step 1.', detectedBy: ['multiStep'] }
    ]
  },
  {
    id: 'dynamic', route: '/dynamic', title: 'Open an account',
    purpose: 'Fields that appear with the answers that need them.',
    fields: [
      { name: 'accountType', label: 'Account type', type: 'select', required: true, options: ['Personal', 'Business'] },
      { name: 'companyName', label: 'Company name', type: 'text', required: true, attrs: { maxlength: 80 }, dependsOn: { field: 'accountType', equals: 'Business' } },
      { name: 'hasReferral', label: 'I have a referral code', type: 'checkbox' },
      { name: 'referralCode', label: 'Referral code', type: 'text', required: true, attrs: { pattern: '[A-Z0-9]{6}', maxlength: 6 }, dependsOn: { field: 'hasReferral', equals: 'on' } },
      { name: 'email', label: 'Email address', type: 'email', required: true }
    ],
    submitLabel: 'Open account',
    defects: [
      { id: 'FL-D12', description: 'The company name is shown for a business account but the server does not require it.', detectedBy: ['dynamic'], skipsConditional: 'companyName' }
    ]
  },
  {
    id: 'file-upload', route: '/file-upload', title: 'Upload a document',
    purpose: 'A file input restricted to PDF and PNG. The 1 MB limit exists only on the server.',
    multipart: true,
    fields: [
      { name: 'title', label: 'Document title', type: 'text', required: true, attrs: { maxlength: 60 } },
      { name: 'document', label: 'Document', type: 'file', required: true, attrs: { accept: '.pdf,.png' }, help: 'PDF or PNG, up to 1 MB.' }
    ],
    serverOnlyRules: ['document: no larger than 1 MB'],
    submitLabel: 'Upload',
    defects: []
  },
  {
    id: 'date-form', route: '/date-form', title: 'Book leave',
    purpose: 'Dates and times with declared ranges and a start-before-end rule.',
    fields: [
      { name: 'startDate', label: 'First day', type: 'date', required: true, attrs: { min: '2020-01-01', max: '2030-12-31' } },
      { name: 'endDate', label: 'Last day', type: 'date', required: true, attrs: { min: '2020-01-01', max: '2030-12-31' } },
      { name: 'startTime', label: 'Start time', type: 'time', required: true },
      { name: 'reminder', label: 'Remind me at', type: 'datetime-local' }
    ],
    crossRules: [
      { id: 'date-order', fields: ['startDate', 'endDate'], kind: 'notBefore', message: 'The last day cannot be before the first day.' }
    ],
    submitLabel: 'Book',
    defects: [
      { id: 'FL-D09', description: 'A last day before the first day is accepted.', detectedBy: ['crossField'], skipsRule: 'date-order' }
    ]
  },
  {
    id: 'dependent-dropdown', route: '/dependent-dropdown', title: 'Choose a region',
    purpose: 'The region list is rebuilt whenever the country changes.',
    dependentOptions: { parent: 'country', child: 'region', map: REGIONS },
    fields: [
      { name: 'country', label: 'Country', type: 'select', required: true, options: COUNTRIES },
      { name: 'region', label: 'Region', type: 'select', required: true, options: REGIONS['United Kingdom'] }
    ],
    submitLabel: 'Continue',
    defects: []
  },
  {
    id: 'validation', route: '/validation', title: 'Validation rules',
    purpose: 'Every declarative constraint, validated on the server with the browser told not to.',
    fields: [
      { name: 'username', label: 'Username', type: 'text', required: true, attrs: { minlength: 3, maxlength: 12, pattern: '[a-z0-9_]+' } },
      { name: 'age', label: 'Age', type: 'number', required: true, attrs: { min: 18, max: 120, step: 1 } },
      { name: 'amount', label: 'Amount', type: 'number', required: true, attrs: { min: 0.01, max: 10000, step: 0.01 } },
      { name: 'quantity', label: 'Quantity', type: 'number', required: true, attrs: { min: 1, max: 99, step: 1 } },
      { name: 'website', label: 'Website', type: 'url' },
      { name: 'phone', label: 'Phone', type: 'tel', attrs: { pattern: '[0-9+ ]{7,15}' } }
    ],
    submitLabel: 'Validate',
    defects: [
      { id: 'FL-D02', description: 'The server accepts an age of 17 though the field declares a minimum of 18.', detectedBy: ['boundary'], skipsMin: 'age' }
    ]
  },
  {
    id: 'accessibility', route: '/accessibility', title: 'Feedback',
    purpose: 'A form with an unlabelled input and an error message nothing points at.',
    a11yBroken: true,
    fields: [
      { name: 'nickname', label: null, placeholder: 'Nickname', type: 'text', required: true },
      { name: 'email', label: 'Email', type: 'email', required: true }
    ],
    submitLabel: 'Send feedback',
    defects: [
      { id: 'FL-D04', description: 'The nickname input has no label, and its error is neither associated with it nor announced.', detectedBy: ['accessibility'] }
    ]
  },
  {
    id: 'error-handling', route: '/error-handling', title: 'Contact support',
    purpose: 'The server crashes on long or null-like messages and shows its stack trace.',
    fields: [
      { name: 'subject', label: 'Subject', type: 'text', required: true, attrs: { maxlength: 100 } },
      { name: 'message', label: 'Message', type: 'textarea', required: true }
    ],
    submitLabel: 'Send',
    defects: [
      { id: 'FL-D05', description: 'A message over 1000 characters, or the text "null", crashes the server with HTTP 500 and a stack trace.', detectedBy: ['inputValidation', 'errorHandling'] }
    ]
  },
  {
    id: 'api-form', route: '/api-form', title: 'Request a callback',
    purpose: 'Submits JSON with fetch and renders the result in place, without navigating.',
    api: '/api/callbacks',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, attrs: { maxlength: 60 } },
      { name: 'phone', label: 'Phone number', type: 'tel', required: true, attrs: { pattern: '[0-9+ ]{7,15}' } },
      { name: 'when', label: 'Preferred time', type: 'select', required: true, options: ['Morning', 'Afternoon', 'Evening'] }
    ],
    submitLabel: 'Request callback',
    defects: []
  },
  {
    id: 'slow-form', route: '/slow-form', title: 'Quote request',
    purpose: 'A correct form whose submission takes three and a half seconds.',
    slowMs: 3500,
    fields: [
      { name: 'company', label: 'Company', type: 'text', required: true, attrs: { maxlength: 80 } },
      { name: 'seats', label: 'Seats', type: 'number', required: true, attrs: { min: 1, max: 500, step: 1 } }
    ],
    submitLabel: 'Get a quote',
    defects: [
      { id: 'FL-D07', description: 'Submission takes 3.5 seconds, over a 2 second response budget.', detectedBy: ['performance'] }
    ]
  },
  {
    id: 'duplicate-submit', route: '/duplicate-submit', title: 'Transfer money',
    purpose: 'A transfer form that submits with fetch, with nothing to stop a second click sending a second transfer.',
    api: '/api/transfers',
    latencyMs: 600,
    fields: [
      { name: 'payee', label: 'Payee', type: 'text', required: true, attrs: { maxlength: 60 } },
      { name: 'amount', label: 'Amount', type: 'number', required: true, attrs: { min: 1, max: 1000, step: 0.01 } }
    ],
    submitLabel: 'Send money',
    defects: [
      { id: 'FL-D03', description: 'Clicking the submit control twice sends two transfers.', detectedBy: ['reliability'] }
    ]
  },
  {
    id: 'session-expiry', route: '/session-expiry', title: 'Session note',
    purpose: 'A form that crashes, rather than asking the user to sign in again, when the session has gone.',
    session: true,
    fields: [
      { name: 'note', label: 'Note', type: 'textarea', required: true, attrs: { maxlength: 500 } }
    ],
    submitLabel: 'Save note',
    defects: [
      { id: 'FL-D13', description: 'Submitting after the session cookie is gone returns HTTP 500 instead of a sign-in prompt.', detectedBy: ['exploratory', 'errorHandling'] }
    ]
  }
];

/** What the platform can discover about a field: its HTML, not the server's rules. */
export function discoverableConstraints(field) {
  const attrs = field.attrs ?? {};
  const out = {};
  for (const key of ['minlength', 'maxlength', 'min', 'max', 'step', 'pattern', 'accept']) {
    if (attrs[key] !== undefined) out[key] = String(attrs[key]);
  }
  return out;
}

/** The ground truth the verification suite reads, generated from the declarations above. */
export function groundTruth(baseUrl) {
  return {
    application: 'QA NXT Golden Form Lab',
    baseUrl,
    generatedFrom: 'test-lab/form-lab/forms.js',
    pages: ['/', ...FORMS.map(form => form.route)],
    forms: FORMS.map(form => ({
      id: form.id,
      route: form.route,
      title: form.title,
      method: form.method ?? (form.api ? 'post' : 'post'),
      submitsWith: form.api ? 'fetch' : 'navigation',
      multiStep: Boolean(form.multiStep),
      submit: form.submitLabel,
      fields: form.fields.map(field => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: Boolean(field.required),
        options: field.options ?? null,
        constraints: discoverableConstraints(field),
        conditional: field.dependsOn ?? null,
        step: field.step ?? null
      })),
      crossRules: (form.crossRules ?? []).map(rule => ({ id: rule.id, fields: rule.fields, kind: rule.kind })),
      dependentOptions: form.dependentOptions ? { parent: form.dependentOptions.parent, child: form.dependentOptions.child } : null,
      serverOnlyRules: form.serverOnlyRules ?? [],
      hasCsrfToken: form.csrf !== false && !form.api,
      defects: form.defects.map(({ id, description, detectedBy }) => ({ id, description, detectedBy }))
    })),
    api: FORMS.filter(form => form.api).map(form => ({ method: 'POST', path: form.api, triggeredBy: form.route }))
  };
}
