/**
 * Hand-checkable test cases for forecast.js. Run with:
 *   node forecast-logic/forecast.test.js
 * No test framework dependency on purpose — this needs to run anywhere,
 * including a throwaway sandbox, without an npm install step.
 */
'use strict';

const assert = require('assert');
const {
  addDays,
  dayOfWeekName,
  getCanadianBankHolidays,
  shiftToBusinessDay,
  isBusinessDay,
  detectRecurringPatterns,
  computeNextDueDate,
  buildForecast,
  getBillsNeedingReminder,
} = require('./forecast.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('Date helpers');
check('addDays crosses month boundary', () => {
  assert.strictEqual(addDays('2026-08-30', 3), '2026-09-02');
});
check('dayOfWeekName matches known date (2026-08-05 is a Wednesday)', () => {
  assert.strictEqual(dayOfWeekName('2026-08-05'), 'Wed');
});

console.log('Canadian bank holidays 2026');
const holidays2026 = getCanadianBankHolidays(2026);
check('Canada Day 2026 (Wed) observed on its own date', () => {
  assert.ok(holidays2026.has('2026-07-01'));
});
check('Christmas 2026 (Fri) observed on its own date', () => {
  assert.ok(holidays2026.has('2026-12-25'));
});
check('Boxing Day 2026 (Sat) observed shifts to Monday 2026-12-28', () => {
  assert.ok(holidays2026.has('2026-12-28'));
});
check('Labour Day 2026 is 1st Monday of Sept = 2026-09-07', () => {
  assert.ok(holidays2026.has('2026-09-07'));
});
check('Thanksgiving 2026 is 2nd Monday of Oct = 2026-10-12', () => {
  assert.ok(holidays2026.has('2026-10-12'));
});
check('Victoria Day 2026 is Monday on/before May 24 = 2026-05-18', () => {
  assert.ok(holidays2026.has('2026-05-18'));
});

console.log('Weekend/holiday shifting');
check('Saturday due date shifts to Monday', () => {
  // 2026-08-08 is a Saturday
  assert.strictEqual(shiftToBusinessDay('2026-08-08', holidays2026), '2026-08-10');
});
check('Sunday due date shifts to Monday', () => {
  assert.strictEqual(shiftToBusinessDay('2026-08-09', holidays2026), '2026-08-10');
});
check('isBusinessDay is false on a stat holiday', () => {
  assert.strictEqual(isBusinessDay('2026-09-07', holidays2026), false); // Labour Day
});

console.log('Recurrence detection');
check('3 monthly same-amount charges are detected as recurring', () => {
  const txns = [
    { transaction_id: 't1', date: '2026-06-05', description: 'SPOTIFY USA', merchant_name: 'Spotify', amount: 10.99, account_name: 'RBC Personal Chequing' },
    { transaction_id: 't2', date: '2026-07-05', description: 'SPOTIFY USA', merchant_name: 'Spotify', amount: 10.99, account_name: 'RBC Personal Chequing' },
    { transaction_id: 't3', date: '2026-08-05', description: 'SPOTIFY USA', merchant_name: 'Spotify', amount: 11.29, account_name: 'RBC Personal Chequing' },
  ];
  const suggestions = detectRecurringPatterns(txns, []);
  assert.strictEqual(suggestions.length, 1);
  assert.strictEqual(suggestions[0].detected_frequency, 'monthly');
  assert.strictEqual(suggestions[0].occurrences, 3);
});
check('amount deviating >5% is not flagged as recurring', () => {
  const txns = [
    { transaction_id: 't1', date: '2026-06-05', description: 'RANDOM STORE', amount: 10.0, account_name: 'RBC Personal Chequing' },
    { transaction_id: 't2', date: '2026-07-05', description: 'RANDOM STORE', amount: 20.0, account_name: 'RBC Personal Chequing' },
  ];
  const suggestions = detectRecurringPatterns(txns, []);
  assert.strictEqual(suggestions.length, 0);
});
check('a single occurrence is never flagged (min occurrences = 2)', () => {
  const txns = [
    { transaction_id: 't1', date: '2026-06-05', description: 'ONE OFF STORE', amount: 10.0, account_name: 'RBC Personal Chequing' },
  ];
  assert.strictEqual(detectRecurringPatterns(txns, []).length, 0);
});
check('a merchant already in Bills is skipped', () => {
  const txns = [
    { transaction_id: 't1', date: '2026-06-01', description: 'NETFLIX.COM', amount: 16.99, account_name: 'RBC Personal Chequing' },
    { transaction_id: 't2', date: '2026-07-01', description: 'NETFLIX.COM', amount: 16.99, account_name: 'RBC Personal Chequing' },
  ];
  const bills = [{ name: 'Netflix' }];
  assert.strictEqual(detectRecurringPatterns(txns, bills).length, 0);
});
check('a merchant already sitting in Suggested Bills is not re-suggested', () => {
  const txns = [
    { transaction_id: 't1', date: '2026-06-01', description: 'SPOTIFY USA', amount: 10.99, account_name: 'RBC Personal Chequing' },
    { transaction_id: 't2', date: '2026-07-01', description: 'SPOTIFY USA', amount: 10.99, account_name: 'RBC Personal Chequing' },
  ];
  const existingSuggestions = [{ detected_name: 'SPOTIFY USA' }];
  assert.strictEqual(detectRecurringPatterns(txns, [], existingSuggestions).length, 0);
});

console.log('Next due date projection');
check('monthly bill due day 1, asOf mid-month rolls to next month', () => {
  const bill = { frequency: 'monthly', due_day_or_date: '1', next_due_date: '2026-08-01' };
  assert.strictEqual(computeNextDueDate(bill, '2026-08-15'), '2026-09-01');
});
check('monthly bill due day 31 clamps in a 30-day month', () => {
  const bill = { frequency: 'monthly', due_day_or_date: '31', next_due_date: '2026-08-31' };
  // September has 30 days, so day 31 clamps to Sept 30.
  assert.strictEqual(computeNextDueDate(bill, '2026-09-01'), '2026-09-30');
});
check('biweekly bill advances in 14-day steps', () => {
  const bill = { frequency: 'biweekly', due_day_or_date: '2026-08-01', next_due_date: '2026-08-01' };
  assert.strictEqual(computeNextDueDate(bill, '2026-08-20'), '2026-08-29');
});

console.log('30-day forecast arithmetic');
check('a single $1850 mortgage on day 26 drops chequing by exactly that plus discretionary drag', () => {
  const bills = [
    {
      bill_id: 'b1', name: 'Mortgage', amount: '1850', frequency: 'monthly',
      due_day_or_date: '1', next_due_date: '2026-09-01',
      account_paid_from: 'RBC Joint Chequing', active: true,
    },
  ];
  // No transactions at all -> discretionary average is $0/day, isolating
  // the bill math so it's hand-checkable.
  const forecast = buildForecast(
    { chequingCombined: 5000, creditCard: 0, loc: 0 },
    bills,
    [],
    '2026-08-05'
  );
  const day0 = forecast.find((r) => r.date === '2026-08-05');
  const dueDay = forecast.find((r) => r.date === '2026-09-01');
  assert.strictEqual(day0.chequing_combined_projected_balance, 5000);
  assert.strictEqual(dueDay.chequing_combined_projected_balance, 5000 - 1850);
  assert.strictEqual(dueDay.below_threshold_flag, false);
});
check('a bill that pushes balance negative sets below_threshold_flag', () => {
  const bills = [
    {
      bill_id: 'b1', name: 'Big Bill', amount: '5000', frequency: 'monthly',
      due_day_or_date: '10', next_due_date: '2026-08-10',
      account_paid_from: 'RBC Joint Chequing', active: true,
    },
  ];
  const forecast = buildForecast(
    { chequingCombined: 1000, creditCard: 0, loc: 0 },
    bills,
    [],
    '2026-08-05'
  );
  const dueDay = forecast.find((r) => r.date === '2026-08-10');
  assert.strictEqual(dueDay.chequing_combined_projected_balance, 1000 - 5000);
  assert.strictEqual(dueDay.below_threshold_flag, true);
});
check('a bill paid from the credit card increases the owed line, not chequing', () => {
  // 2026-08-14 is a Friday (business day) so no weekend shift complicates the assertion.
  const bills = [
    {
      bill_id: 'b1', name: 'Annual Fee', amount: '120', frequency: 'monthly',
      due_day_or_date: '14', next_due_date: '2026-08-14',
      account_paid_from: 'RBC Credit Card', active: true,
    },
  ];
  const forecast = buildForecast(
    { chequingCombined: 1000, creditCard: 200, loc: 0 },
    bills,
    [],
    '2026-08-05'
  );
  const dueDay = forecast.find((r) => r.date === '2026-08-14');
  assert.strictEqual(dueDay.chequing_combined_projected_balance, 1000);
  assert.strictEqual(dueDay.credit_card_projected_balance_owed, 320);
});
check('a weekend due date is reflected on the shifted business day, not the literal date', () => {
  // 2026-08-08 is a Saturday -> should shift to Monday 2026-08-10
  const bills = [
    {
      bill_id: 'b1', name: 'Weekend Bill', amount: '50', frequency: 'weekly',
      due_day_or_date: '2026-08-08', next_due_date: '2026-08-08',
      account_paid_from: 'RBC Joint Chequing', active: true,
    },
  ];
  const forecast = buildForecast(
    { chequingCombined: 1000, creditCard: 0, loc: 0 },
    bills,
    [],
    '2026-08-05'
  );
  const saturday = forecast.find((r) => r.date === '2026-08-08');
  const monday = forecast.find((r) => r.date === '2026-08-10');
  assert.strictEqual(saturday.bill_amount_today, 0);
  assert.strictEqual(monday.bill_amount_today, 50);
});

console.log('SMS reminder selection');
// 2026-08-04 is a Tuesday, 2026-08-07 is the Friday 3 days later (both
// business days, so weekend shifting doesn't complicate the assertion).
check('a bill due in exactly 3 days is flagged for reminder (default lead time)', () => {
  const bills = [
    {
      bill_id: 'b1', name: 'Netflix', amount: '16.99', frequency: 'monthly',
      due_day_or_date: '7', next_due_date: '2026-08-07',
      account_paid_from: 'RBC Personal Chequing', active: true, last_reminder_sent_date: '',
    },
  ];
  const due = getBillsNeedingReminder(bills, '2026-08-04');
  assert.strictEqual(due.length, 1);
  assert.strictEqual(due[0].days_until, 3);
  assert.strictEqual(due[0].due_date, '2026-08-07');
});
check('a bill already reminded for this occurrence is not flagged again', () => {
  const bills = [
    {
      bill_id: 'b1', name: 'Netflix', amount: '16.99', frequency: 'monthly',
      due_day_or_date: '7', next_due_date: '2026-08-07',
      account_paid_from: 'RBC Personal Chequing', active: true,
      last_reminder_sent_date: '2026-08-07',
    },
  ];
  const due = getBillsNeedingReminder(bills, '2026-08-04');
  assert.strictEqual(due.length, 0);
});
check('a weekend-landing due date is compared against its shifted business day for lead time', () => {
  // 2026-08-08 is a Saturday -> shifts to Monday 2026-08-10, which is
  // 5 business-calendar days from 2026-08-05, outside the 3-day lead time.
  const bills = [
    {
      bill_id: 'b1', name: 'Weekend Bill', amount: '50', frequency: 'monthly',
      due_day_or_date: '8', next_due_date: '2026-08-08',
      account_paid_from: 'RBC Personal Chequing', active: true, last_reminder_sent_date: '',
    },
  ];
  const due = getBillsNeedingReminder(bills, '2026-08-05');
  assert.strictEqual(due.length, 0);
});
check('a bill due 10 days out is not flagged yet', () => {
  const bills = [
    {
      bill_id: 'b1', name: 'Far Off', amount: '100', frequency: 'monthly',
      due_day_or_date: '15', next_due_date: '2026-08-15',
      account_paid_from: 'RBC Personal Chequing', active: true, last_reminder_sent_date: '',
    },
  ];
  const due = getBillsNeedingReminder(bills, '2026-08-05');
  assert.strictEqual(due.length, 0);
});

console.log(`\n${passed} test(s) passed${process.exitCode ? ', SOME FAILED' : ''}`);
