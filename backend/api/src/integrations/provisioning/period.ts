import { BillingCycle } from '../../modules/accounts/entities/account.entity';

/** Inclusive UTC calendar billing window; never approximate a month/year in days. */
export function initialPeriod(date: Date, cycle: BillingCycle): { start: string; end: string } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const start = new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
  const destinationYear = year + (cycle === BillingCycle.ANNUAL ? 1 : 0);
  const destinationMonth = month + (cycle === BillingCycle.MONTHLY ? 1 : 0);
  if (cycle !== BillingCycle.MONTHLY && cycle !== BillingCycle.ANNUAL) {
    throw new Error('Invalid billing cycle');
  }
  const lastDay = new Date(Date.UTC(destinationYear, destinationMonth + 1, 0)).getUTCDate();
  const next = new Date(Date.UTC(destinationYear, destinationMonth, Math.min(day, lastDay)));
  next.setUTCDate(next.getUTCDate() - 1);
  return { start, end: next.toISOString().slice(0, 10) };
}
