/**
 * forecast.js
 *
 * Recurrence detection + 30-day cash flow forecast, in plain documented
 * JavaScript, with no external dependencies (so it drops into a Zapier
 * "Code by Zapier" (NodeJS) step unmodified — see
 * ../03-zapier-zap-spec.md for exactly which functions go in which step).
 *
 * This file is runnable directly with Node for testing/auditing:
 *   node forecast-logic/forecast.test.js
 *
 * Everything here is deliberately simple, deterministic math — no ML, no
 * black boxes. Every number in the Forecast tab should be traceable back
 * to a line in this file.
 */

'use strict';

// ---------------------------------------------------------------------------
// Config — the four "open questions" from the spec, resolved here as named
// constants. Change a value here (or override via `overrides` passed into
// runForecast) rather than hunting through the logic below.
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  FORECAST_DAYS: 30,
  SMS_LEAD_DAYS: 3, // days before due date to send a reminder
  LOW_BALANCE_FLOOR: 0, // flag any day the chequing line projects below this
  DISCRETIONARY_LOOKBACK_DAYS: 90, // trailing window for the daily spend average
  RECURRENCE_MIN_OCCURRENCES: 2,
  RECURRENCE_AMOUNT_TOLERANCE_PCT: 0.05, // ±5%
  // Frequency classification bands, in days between occurrences.
  RECURRENCE_FREQUENCY_BANDS: [
    { name: 'weekly', min: 6, max: 8 },
    { name: 'biweekly', min: 13, max: 15 },
    { name: 'monthly', min: 27, max: 32 },
  ],
  // Chequing accounts are combined into one forecast line; credit/LOC
  // accounts are tracked separately as amounts owed. See README assumption.
  CHEQUING_ACCOUNT_NAMES: ['RBC Joint Chequing', 'RBC Personal Chequing'],
  CREDIT_CARD_ACCOUNT_NAME: 'RBC Credit Card',
  LOC_ACCOUNT_NAME: 'RBC Line of Credit',
};

// ---------------------------------------------------------------------------
// Date helpers (no external date library — plain ISO string math)
// ---------------------------------------------------------------------------

function parseISODate(dateStr) {
  // Parse as UTC midnight to avoid local-timezone drift shifting the day.
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatISODate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = parseISODate(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return formatISODate(d);
}

function dayOfWeekName(dateStr) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return names[parseISODate(dateStr).getUTCDay()];
}

function daysBetween(dateStrA, dateStrB) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((parseISODate(dateStrB) - parseISODate(dateStrA)) / msPerDay);
}

/**
 * Canadian statutory / RBC branch holidays for a given calendar year.
 * Covers the holidays RBC actually closes for (federal schedule), which is
 * what determines whether a pre-authorized debit posts same-day or rolls
 * to the next business day. Floating holidays (Nth weekday of a month) are
 * computed; fixed-date ones are literal.
 */
function getCanadianBankHolidays(year) {
  const holidays = new Set();

  const nthWeekdayOfMonth = (y, monthIndex0, weekday, n) => {
    const d = new Date(Date.UTC(y, monthIndex0, 1));
    let count = 0;
    while (d.getUTCMonth() === monthIndex0) {
      if (d.getUTCDay() === weekday) {
        count += 1;
        if (count === n) return formatISODate(d);
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return null;
  };

  const lastWeekdayOnOrBefore = (y, monthIndex0, day, weekday) => {
    const d = new Date(Date.UTC(y, monthIndex0, day));
    while (d.getUTCDay() !== weekday) {
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return formatISODate(d);
  };

  const goodFriday = (y) => {
    // Anonymous Gregorian algorithm for Easter Sunday, then -2 days.
    const a = y % 19;
    const b = Math.floor(y / 100);
    const c = y % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    const easter = new Date(Date.UTC(y, month - 1, day));
    easter.setUTCDate(easter.getUTCDate() - 2);
    return formatISODate(easter);
  };

  holidays.add(`${year}-01-01`); // New Year's Day
  holidays.add(goodFriday(year)); // Good Friday
  holidays.add(lastWeekdayOnOrBefore(year, 4, 24, 1)); // Victoria Day: Monday on/before May 24 (month index 4 = May)
  holidays.add(`${year}-07-01`); // Canada Day
  holidays.add(nthWeekdayOfMonth(year, 8, 1, 1)); // Labour Day: 1st Monday of September
  holidays.add(`${year}-09-30`); // National Day for Truth and Reconciliation
  holidays.add(nthWeekdayOfMonth(year, 9, 1, 2)); // Thanksgiving: 2nd Monday of October
  holidays.add(`${year}-11-11`); // Remembrance Day
  holidays.add(`${year}-12-25`); // Christmas Day
  holidays.add(`${year}-12-26`); // Boxing Day

  // Weekend-observed shifting for fixed dates that land on a weekend
  // (e.g. Canada Day on a Saturday is observed the following Monday).
  const observed = new Set();
  for (const iso of holidays) {
    if (!iso) continue;
    const dow = parseISODate(iso).getUTCDay();
    if (dow === 0) observed.add(addDays(iso, 1)); // Sun -> Mon
    else if (dow === 6) observed.add(addDays(iso, 2)); // Sat -> Mon
    else observed.add(iso);
  }
  return observed;
}

function isBusinessDay(dateStr, holidaySet) {
  const dow = parseISODate(dateStr).getUTCDay();
  if (dow === 0 || dow === 6) return false;
  if (holidaySet.has(dateStr)) return false;
  return true;
}

/** A bill due on a non-business day is modeled as posting the next business day. */
function shiftToBusinessDay(dateStr, holidaySet) {
  let d = dateStr;
  while (!isBusinessDay(d, holidaySet)) {
    d = addDays(d, 1);
  }
  return d;
}

// ---------------------------------------------------------------------------
// Recurrence detection (spec section 5)
// ---------------------------------------------------------------------------

/** Strip store numbers, extra whitespace, and common noise so the same
 * merchant matches across slightly different description strings. */
function normalizeMerchantKey(txn) {
  const raw = (txn.merchant_name || txn.description || '').toUpperCase();
  return raw
    .replace(/[0-9]{3,}/g, '') // drop long numeric store/reference codes
    .replace(/[^A-Z ]/g, ' ') // drop punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyFrequency(avgGapDays, bands) {
  for (const band of bands) {
    if (avgGapDays >= band.min && avgGapDays <= band.max) return band.name;
  }
  return null;
}

/**
 * Given all transactions and the existing Bills list, find recurring
 * patterns that are NOT already tracked in Bills, so they can be written
 * to Suggested Bills for manual review. Never returns anything that should
 * be auto-promoted — that step is always manual (spec section 5).
 */
function detectRecurringPatterns(transactions, bills, existingSuggestions = [], config = DEFAULT_CONFIG) {
  const knownBillKeys = bills.map((b) => normalizeMerchantKey({ description: b.name })).filter(Boolean);
  const matchesKnownBill = (key) =>
    knownBillKeys.some((bk) => key.includes(bk) || bk.includes(key));

  // Already-surfaced suggestions (pending, promoted, or dismissed) should
  // not be re-added every night — that's the caller's job to review once,
  // not something the detector should nag about repeatedly.
  const knownSuggestionKeys = new Set(
    existingSuggestions.map((s) => normalizeMerchantKey({ description: s.detected_name }))
  );

  // Only consider debits (money out) — bills are outflows.
  const debits = transactions.filter((t) => Number(t.amount) > 0);

  const groups = new Map();
  for (const t of debits) {
    const key = normalizeMerchantKey(t);
    if (!key || matchesKnownBill(key) || knownSuggestionKeys.has(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const suggestions = [];
  for (const [key, txns] of groups.entries()) {
    if (txns.length < config.RECURRENCE_MIN_OCCURRENCES) continue;

    txns.sort((a, b) => (a.date < b.date ? -1 : 1));

    const amounts = txns.map((t) => Number(t.amount));
    const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const maxDeviationPct =
      Math.max(...amounts.map((a) => Math.abs(a - avgAmount) / avgAmount));
    if (maxDeviationPct > config.RECURRENCE_AMOUNT_TOLERANCE_PCT) continue;

    const gaps = [];
    for (let i = 1; i < txns.length; i++) {
      gaps.push(daysBetween(txns[i - 1].date, txns[i].date));
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const frequency = classifyFrequency(avgGap, config.RECURRENCE_FREQUENCY_BANDS);
    if (!frequency) continue; // gaps too irregular to call it recurring

    suggestions.push({
      detected_name: key,
      matched_transaction_ids: txns.map((t) => t.transaction_id).join(','),
      avg_amount: Number(avgAmount.toFixed(2)),
      amount_variance_pct: Number((maxDeviationPct * 100).toFixed(1)),
      detected_frequency: frequency,
      occurrences: txns.length,
      first_seen_date: txns[0].date,
      last_seen_date: txns[txns.length - 1].date,
      account: txns[txns.length - 1].account_name,
      status: 'pending',
    });
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Bill due-date projection
// ---------------------------------------------------------------------------

/** Advance a bill's due date forward from `fromDateStr` to the next
 * occurrence on/after `asOfDateStr`, per its frequency. */
function computeNextDueDate(bill, asOfDateStr) {
  const freq = bill.frequency;
  let anchor = bill.next_due_date || bill.due_day_or_date;

  if (freq === 'monthly' || freq === 'quarterly' || freq === 'annual') {
    const monthsStep = freq === 'monthly' ? 1 : freq === 'quarterly' ? 3 : 12;
    const dueDay = Number(bill.due_day_or_date);
    let candidate = anchor;
    // Walk forward month-by-month (or the appropriate step) until the
    // candidate date is on/after asOfDateStr.
    let [y, m] = candidate.split('-').map(Number);
    let d = parseISODate(`${y}-${String(m).padStart(2, '0')}-01`);
    d.setUTCDate(Math.min(dueDay, daysInMonth(d.getUTCFullYear(), d.getUTCMonth())));
    candidate = formatISODate(d);
    while (candidate < asOfDateStr) {
      d.setUTCMonth(d.getUTCMonth() + monthsStep, 1);
      d.setUTCDate(Math.min(dueDay, daysInMonth(d.getUTCFullYear(), d.getUTCMonth())));
      candidate = formatISODate(d);
    }
    return candidate;
  }

  if (freq === 'weekly' || freq === 'biweekly') {
    const stepDays = freq === 'weekly' ? 7 : 14;
    let candidate = anchor;
    while (candidate < asOfDateStr) {
      candidate = addDays(candidate, stepDays);
    }
    return candidate;
  }

  return anchor;
}

function daysInMonth(year, monthIndex0) {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Discretionary spend estimate
// ---------------------------------------------------------------------------

/** Average daily non-fixed-bill spend over the trailing lookback window,
 * used as a flat per-day estimate for every future forecast day. */
function computeDiscretionaryDailyAverage(transactions, bills, asOfDateStr, config = DEFAULT_CONFIG) {
  const billKeys = new Set(bills.map((b) => normalizeMerchantKey({ description: b.name })));
  const windowStart = addDays(asOfDateStr, -config.DISCRETIONARY_LOOKBACK_DAYS);

  const discretionaryDebits = transactions.filter((t) => {
    if (Number(t.amount) <= 0) return false; // only outflows
    if (t.date < windowStart || t.date >= asOfDateStr) return false;
    if (t.is_fixed_bill_match === true || t.is_fixed_bill_match === 'TRUE') return false;
    if (billKeys.has(normalizeMerchantKey(t))) return false;
    return true;
  });

  const total = discretionaryDebits.reduce((sum, t) => sum + Number(t.amount), 0);
  return Number((total / config.DISCRETIONARY_LOOKBACK_DAYS).toFixed(2));
}

// ---------------------------------------------------------------------------
// 30-day forecast
// ---------------------------------------------------------------------------

/**
 * @param {object} startBalances - { chequingCombined, creditCard, loc } as of asOfDateStr
 * @param {array} bills - rows from the Bills tab (active only should be pre-filtered by caller)
 * @param {array} transactions - rows from the Transactions tab (used for discretionary average)
 * @param {string} asOfDateStr - "today" in YYYY-MM-DD
 * @param {object} config
 */
function buildForecast(startBalances, bills, transactions, asOfDateStr, config = DEFAULT_CONFIG) {
  const activeBills = bills.filter((b) => b.active === true || b.active === 'TRUE');
  const dailyDiscretionary = computeDiscretionaryDailyAverage(transactions, bills, asOfDateStr, config);

  const years = new Set();
  for (let i = 0; i <= config.FORECAST_DAYS; i++) {
    years.add(parseISODate(addDays(asOfDateStr, i)).getUTCFullYear());
  }
  const holidaySet = new Set();
  for (const y of years) for (const h of getCanadianBankHolidays(y)) holidaySet.add(h);

  // Pre-compute each bill's next shifted occurrence(s) within the window.
  // A bill can recur more than once inside 30 days (e.g. weekly), so we
  // walk each bill forward independently and collect every hit.
  const billHitsByDate = new Map(); // dateStr -> [{name, amount, account}]
  for (const bill of activeBills) {
    let cursorDate = asOfDateStr;
    const windowEnd = addDays(asOfDateStr, config.FORECAST_DAYS);
    // Safety cap so a misconfigured weekly bill can't loop unreasonably.
    for (let guard = 0; guard < 40; guard++) {
      const rawDue = computeNextDueDate(bill, cursorDate);
      if (rawDue > windowEnd) break;
      const shiftedDue = shiftToBusinessDay(rawDue, holidaySet);
      if (shiftedDue > windowEnd) break;
      if (!billHitsByDate.has(shiftedDue)) billHitsByDate.set(shiftedDue, []);
      billHitsByDate.get(shiftedDue).push({
        name: bill.name,
        amount: Number(bill.amount),
        account: bill.account_paid_from,
      });
      const nonRecurring = !['weekly', 'biweekly', 'monthly', 'quarterly', 'annual'].includes(bill.frequency);
      if (nonRecurring) break;
      cursorDate = addDays(rawDue, 1);
    }
  }

  const rows = [];
  let chequing = startBalances.chequingCombined;
  let creditCard = startBalances.creditCard;
  let loc = startBalances.loc;

  for (let i = 0; i <= config.FORECAST_DAYS; i++) {
    const date = addDays(asOfDateStr, i);
    const hits = billHitsByDate.get(date) || [];

    let billAmountToday = 0;
    for (const hit of hits) {
      if (hit.account === config.CREDIT_CARD_ACCOUNT_NAME) {
        creditCard += hit.amount;
      } else if (hit.account === config.LOC_ACCOUNT_NAME) {
        loc += hit.amount;
      } else {
        chequing -= hit.amount;
        billAmountToday += hit.amount;
      }
    }

    // Discretionary spend applies every day including today, except we
    // don't retroactively apply it to day 0 twice on reruns — this is a
    // pure projection, so day 0 is treated as "already lived" only in the
    // sense that its bills already reflect real Balances; discretionary is
    // still subtracted going forward from day 0 to keep the curve smooth.
    if (i > 0) {
      chequing -= dailyDiscretionary;
    }

    const belowThreshold = chequing < config.LOW_BALANCE_FLOOR;

    rows.push({
      date,
      day_of_week: dayOfWeekName(date),
      is_business_day: isBusinessDay(date, holidaySet),
      chequing_combined_projected_balance: Number(chequing.toFixed(2)),
      credit_card_projected_balance_owed: Number(creditCard.toFixed(2)),
      loc_projected_balance_owed: Number(loc.toFixed(2)),
      bills_due_today: hits.map((h) => h.name).join(', '),
      bill_amount_today: Number(billAmountToday.toFixed(2)),
      discretionary_spend_estimate: i === 0 ? 0 : dailyDiscretionary,
      running_total: Number(chequing.toFixed(2)),
      below_threshold_flag: belowThreshold,
      notes: hits.length ? `${hits.map((h) => h.name).join(' + ')} due` : '',
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// SMS reminder selection (spec section 4, step 7)
// ---------------------------------------------------------------------------

/**
 * Bills due within the next SMS_LEAD_DAYS days that haven't already had a
 * reminder sent for this specific occurrence. Returns bills annotated with
 * the shifted due date and days-until, plus the new last_reminder_sent_date
 * to write back to the Bills tab after sending.
 */
function getBillsNeedingReminder(bills, asOfDateStr, config = DEFAULT_CONFIG) {
  const years = new Set([
    parseISODate(asOfDateStr).getUTCFullYear(),
    parseISODate(addDays(asOfDateStr, config.SMS_LEAD_DAYS + 1)).getUTCFullYear(),
  ]);
  const holidaySet = new Set();
  for (const y of years) for (const h of getCanadianBankHolidays(y)) holidaySet.add(h);

  const activeBills = bills.filter((b) => b.active === true || b.active === 'TRUE');
  const due = [];

  for (const bill of activeBills) {
    const rawDue = computeNextDueDate(bill, asOfDateStr);
    const shiftedDue = shiftToBusinessDay(rawDue, holidaySet);
    const daysUntil = daysBetween(asOfDateStr, shiftedDue);

    if (daysUntil < 0 || daysUntil > config.SMS_LEAD_DAYS) continue;
    if (bill.last_reminder_sent_date === shiftedDue) continue; // already reminded for this occurrence

    due.push({
      bill_id: bill.bill_id,
      name: bill.name,
      amount: bill.amount,
      due_date: shiftedDue,
      days_until: daysUntil,
      account_paid_from: bill.account_paid_from,
      new_last_reminder_sent_date: shiftedDue,
    });
  }

  return due;
}

function buildReminderSmsBody(dueBills) {
  const lines = dueBills.map(
    (b) => `${b.name}: $${Number(b.amount).toFixed(2)} due ${b.due_date} (${b.account_paid_from})`
  );
  return `Upcoming bills:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Entry point for a Zapier "Code by Zapier" step.
// See ../03-zapier-zap-spec.md for how inputData is assembled from the
// preceding Google Sheets "Get Many Rows" steps.
// ---------------------------------------------------------------------------
function runForecast(inputData, overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const { transactions, bills, balances, asOfDate, existingSuggestedBills = [] } = inputData;

  const chequingTotal = balances
    .filter((b) => config.CHEQUING_ACCOUNT_NAMES.includes(b.account_name))
    .reduce((sum, b) => sum + Number(b.current_balance), 0);
  const creditCardBalance =
    Number(balances.find((b) => b.account_name === config.CREDIT_CARD_ACCOUNT_NAME)?.current_balance) || 0;
  const locBalance =
    Number(balances.find((b) => b.account_name === config.LOC_ACCOUNT_NAME)?.current_balance) || 0;

  const forecast = buildForecast(
    { chequingCombined: chequingTotal, creditCard: creditCardBalance, loc: locBalance },
    bills,
    transactions,
    asOfDate,
    config
  );

  const suggestedBills = detectRecurringPatterns(transactions, bills, existingSuggestedBills, config);
  const remindersDue = getBillsNeedingReminder(bills, asOfDate, config);

  return {
    forecast,
    suggestedBills,
    remindersDue,
    smsBody: remindersDue.length ? buildReminderSmsBody(remindersDue) : null,
  };
}

// ---------------------------------------------------------------------------
// Exports (Node/testing). In the actual Zapier Code step, delete this
// module.exports block and instead end the script with:
//   output = runForecast(inputData);
// as described in ../03-zapier-zap-spec.md.
// ---------------------------------------------------------------------------
if (typeof module !== 'undefined') {
  module.exports = {
    DEFAULT_CONFIG,
    addDays,
    dayOfWeekName,
    daysBetween,
    getCanadianBankHolidays,
    isBusinessDay,
    shiftToBusinessDay,
    normalizeMerchantKey,
    detectRecurringPatterns,
    computeNextDueDate,
    computeDiscretionaryDailyAverage,
    buildForecast,
    getBillsNeedingReminder,
    buildReminderSmsBody,
    runForecast,
  };
}
