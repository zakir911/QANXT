/**
 * Synthetic banking data. Deliberately small, deterministic and obviously fake:
 * sort codes and account numbers follow documentation-reserved patterns so that
 * nothing here can be mistaken for, or used against, a real banking system.
 */

export const users = [
  {
    id: 'u-alice',
    username: 'alice',
    password: 'Password123!',
    displayName: 'Alice Fernandes',
    email: 'alice@demo-bank.test',
    status: 'active',
    phone: '+44 20 7946 0000'
  },
  {
    id: 'u-bob',
    username: 'bob',
    password: 'Password123!',
    displayName: 'Bob Okonkwo',
    email: 'bob@demo-bank.test',
    status: 'active',
    phone: '+44 20 7946 0001'
  },
  {
    id: 'u-locked',
    username: 'locked',
    password: 'Password123!',
    displayName: 'Locked Customer',
    email: 'locked@demo-bank.test',
    status: 'locked',
    phone: '+44 20 7946 0002'
  }
];

export const accounts = [
  { id: 'acc-1001', userId: 'u-alice', name: 'Everyday Current', type: 'Current', number: '00000101', sortCode: '00-00-00', balance: 2481.55, currency: 'GBP' },
  { id: 'acc-1002', userId: 'u-alice', name: 'Rainy Day Savings', type: 'Savings', number: '00000102', sortCode: '00-00-00', balance: 14320.10, currency: 'GBP' },
  { id: 'acc-1003', userId: 'u-alice', name: 'Travel Card', type: 'Prepaid', number: '00000103', sortCode: '00-00-00', balance: 175.00, currency: 'GBP' },
  { id: 'acc-2001', userId: 'u-bob', name: 'Everyday Current', type: 'Current', number: '00000201', sortCode: '00-00-00', balance: 0.00, currency: 'GBP' }
];

/** Transactions are generated from a fixed seed so every run sees the same history. */
export const transactions = buildTransactions();

function buildTransactions() {
  const merchants = [
    ['Greenfield Grocers', 'Groceries'], ['Metro Transit', 'Travel'], ['Cafe Lumen', 'Eating out'],
    ['Riverbank Energy', 'Utilities'], ['Northwind Books', 'Shopping'], ['Atlas Gym', 'Health'],
    ['Salary — Contoso Ltd', 'Income'], ['Bright Mobile', 'Utilities']
  ];

  const rows = [];
  let seed = 20260101;
  const next = () => {
    // Deterministic LCG: the same history every time the app starts, which matters
    // because tests assert against it.
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  for (const account of accounts) {
    if (account.id === 'acc-2001') continue;        // Bob's account is deliberately empty
    for (let day = 0; day < 60; day++) {
      const perDay = account.type === 'Current' ? 2 : 1;
      for (let i = 0; i < perDay; i++) {
        const pick = merchants[Math.floor(next() * merchants.length)];
        const isIncome = pick[1] === 'Income';
        const amount = isIncome
          ? Math.round((2200 + next() * 400) * 100) / 100
          : -Math.round((3 + next() * 160) * 100) / 100;
        const date = new Date(Date.UTC(2026, 6, 1) - day * 86400000);
        rows.push({
          id: `txn-${account.id}-${day}-${i}`,
          accountId: account.id,
          date: date.toISOString().slice(0, 10),
          description: pick[0],
          category: pick[1],
          amount,
          balanceAfter: 0
        });
      }
    }
  }

  // Running balance, newest first, so a statement reads the way a customer expects.
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const account of accounts) {
    let running = account.balance;
    for (const row of rows.filter(r => r.accountId === account.id)) {
      row.balanceAfter = Math.round(running * 100) / 100;
      running = Math.round((running - row.amount) * 100) / 100;
    }
  }

  return rows;
}

export const payees = [
  { id: 'pay-1', userId: 'u-alice', name: 'Jordan Reyes', sortCode: '00-00-01', number: '00000301' },
  { id: 'pay-2', userId: 'u-alice', name: 'Riverbank Energy', sortCode: '00-00-02', number: '00000302' }
];

export function findUser(username) {
  return users.find(u => u.username.toLowerCase() === String(username ?? '').toLowerCase().trim());
}

export function accountsFor(userId) {
  return accounts.filter(a => a.userId === userId);
}

export function transactionsFor(accountId) {
  return transactions.filter(t => t.accountId === accountId);
}
