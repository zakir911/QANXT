/**
 * Synthetic banking data.
 *
 * Generated from a fixed seed so that every run of the lab sees the same accounts, the
 * same transactions and the same balances. Verification that cannot be repeated is not
 * verification, and a test that asserts a balance needs that balance to be stable.
 *
 * None of this is real. The names, sort codes and account numbers are invented, the
 * amounts are arbitrary, and nothing here touches a real financial system.
 */

/** Mulberry32: small, fast, and identical on every platform. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const USERS = [
  { id: 'usr-alice', username: 'alice', password: 'Password123!', displayName: 'Alice Fernsby',
    email: 'alice@example.test', phone: '+44 7700 900123' },
  { id: 'usr-bob', username: 'bob', password: 'Password123!', displayName: 'Bob Marchetti',
    email: 'bob@example.test', phone: '+44 7700 900456' }
];

export const ACCOUNTS = [
  { id: 'acc-1001', userId: 'usr-alice', name: 'Everyday Current', type: 'current', number: '****4412', sortCode: '04-00-72', currency: 'GBP', openingBalance: 4820.55 },
  { id: 'acc-1002', userId: 'usr-alice', name: 'Rainy Day Savings', type: 'savings', number: '****8830', sortCode: '04-00-72', currency: 'GBP', openingBalance: 15240.00 },
  { id: 'acc-1003', userId: 'usr-alice', name: 'Travel Credit', type: 'credit', number: '****2201', sortCode: '04-00-72', currency: 'GBP', openingBalance: -742.18 },
  { id: 'acc-2001', userId: 'usr-bob', name: 'Bob Current', type: 'current', number: '****6654', sortCode: '04-00-72', currency: 'GBP', openingBalance: 980.10 }
];

export const CATEGORIES = ['Groceries', 'Transport', 'Utilities', 'Dining', 'Salary', 'Transfer', 'Entertainment'];

export const BENEFICIARIES = [
  { id: 'ben-01', userId: 'usr-alice', name: 'Thames Energy', accountNumber: '****9010', sortCode: '20-11-08', reference: 'TE-4412' },
  { id: 'ben-02', userId: 'usr-alice', name: 'Harriet Vale', accountNumber: '****3321', sortCode: '30-96-21', reference: 'Rent' },
  { id: 'ben-03', userId: 'usr-alice', name: 'Greenfield Council', accountNumber: '****7745', sortCode: '60-11-04', reference: 'CTAX-88213' },
  { id: 'ben-04', userId: 'usr-bob', name: 'Northwind Gym', accountNumber: '****1188', sortCode: '23-05-80', reference: 'GYM-7' }
];

/** A fixed "today" so date filters and statement ranges mean the same thing every run. */
export const REFERENCE_DATE = new Date('2026-09-15T12:00:00Z');

function buildTransactions() {
  const all = [];
  for (const account of ACCOUNTS) {
    const random = seeded(Number.parseInt(account.id.replace(/\D/g, ''), 10));

    // Dates are drawn first and sorted, then the running balance is walked forward over
    // them. Generating in random order and sorting afterwards would leave every
    // `balanceAfter` inconsistent with the history shown above it — a detail a person
    // reading a statement would notice immediately, and one an assertion would trip over.
    const days = Array.from({ length: 120 }, () => Math.floor(random() * 180)).sort((a, b) => b - a);
    let running = account.openingBalance;

    days.forEach((daysAgo, index) => {
      const date = new Date(REFERENCE_DATE.getTime() - daysAgo * 86_400_000);
      const category = CATEGORIES[Math.floor(random() * CATEGORIES.length)];
      const credit = category === 'Salary' || (category === 'Transfer' && random() > 0.5);
      const amount = Number(((credit ? 1 : -1) * (5 + random() * (credit ? 2200 : 180))).toFixed(2));
      running = Number((running + amount).toFixed(2));

      all.push({
        id: `txn-${account.id.slice(4)}-${String(index + 1).padStart(3, '0')}`,
        accountId: account.id,
        date: date.toISOString().slice(0, 10),
        description: describe(category, random),
        category,
        amount,
        balanceAfter: running,
        reference: `REF${Math.floor(random() * 900000 + 100000)}`
      });
    });
  }
  // Newest first: the order every statement and transaction list in the application uses.
  return all.reverse();
}

function describe(category, random) {
  const merchants = {
    Groceries: ['Maple & Vine', 'Corner Market', 'Fresh Fields'],
    Transport: ['City Transit', 'Rail Network', 'Cabsmart'],
    Utilities: ['Thames Energy', 'Clearwater', 'Fibrelink'],
    Dining: ['The Copper Pot', 'Noodle House', 'Cafe Ostra'],
    Salary: ['Northwind Ltd Payroll'],
    Transfer: ['Internal transfer', 'Standing order'],
    Entertainment: ['Cine Royale', 'Streamly', 'Vinyl Depot']
  }[category];
  return merchants[Math.floor(random() * merchants.length)];
}

export const TRANSACTIONS = buildTransactions();

export function accountsFor(userId) {
  return ACCOUNTS.filter(account => account.userId === userId).map(account => ({
    ...account,
    balance: balanceOf(account.id)
  }));
}

export function balanceOf(accountId) {
  const latest = TRANSACTIONS.find(transaction => transaction.accountId === accountId);
  return latest ? latest.balanceAfter : ACCOUNTS.find(a => a.id === accountId)?.openingBalance ?? 0;
}

export function transactionsFor(accountId) {
  return TRANSACTIONS.filter(transaction => transaction.accountId === accountId);
}

export function beneficiariesFor(userId) {
  return BENEFICIARIES.filter(beneficiary => beneficiary.userId === userId);
}

export function userById(id) {
  return USERS.find(user => user.id === id) ?? null;
}
