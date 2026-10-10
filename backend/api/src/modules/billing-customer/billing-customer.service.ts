import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import controlDataSource from '../../database/data-source';
import { Account, Locale } from '../accounts/entities/account.entity';
import { Plan } from '../entitlements/entities/plan.entity';
import { Tenant } from '../tenants/entities/tenant.entity';
import {
  Subscription,
  SubscriptionBillingCycle,
  SubscriptionStatus,
} from './entities/subscription.entity';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SubscriptionView {
  status: SubscriptionStatus;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  amountDue: number;
  currency: string;
  bankInstructions: string;
  paymentReference: string;
}

/**
 * Reads the caller's billing relationship from control-plane records created by T044.
 * Identity is always the verified JWT subject; no tenant, subscription, amount, currency,
 * or reference is accepted from the client.
 */
@Injectable()
export class BillingCustomerService {
  async getSubscription(keycloakUserId: string): Promise<SubscriptionView> {
    if (!UUID_PATTERN.test(keycloakUserId)) {
      throw new UnauthorizedException('No account is linked to the authenticated user');
    }

    const account = await controlDataSource.getRepository(Account).findOne({
      where: { keycloakUserId },
    });
    if (!account) {
      throw new UnauthorizedException('No account is linked to the authenticated user');
    }

    const tenant = await controlDataSource.getRepository(Tenant).findOne({
      where: { accountId: account.id },
    });
    if (!tenant) {
      throw new NotFoundException('No tenant is linked to the authenticated account');
    }

    const subscription = await controlDataSource.getRepository(Subscription).findOne({
      where: { tenantId: tenant.id },
    });
    if (!subscription) {
      throw new NotFoundException('No subscription is linked to the authenticated tenant');
    }

    const plan = await controlDataSource.getRepository(Plan).findOne({
      where: { id: subscription.planId },
    });
    if (!plan) {
      throw new InternalServerErrorException('The subscription plan is unavailable');
    }

    const amountDue = this.amountForCycle(plan, subscription.billingCycle);
    const locale = account.preferredLocale ?? Locale.EN;

    return {
      status: subscription.status,
      billingPeriodStart: subscription.currentPeriodStart,
      billingPeriodEnd: subscription.currentPeriodEnd,
      amountDue,
      currency: plan.currency,
      bankInstructions: bankInstructionsFor(locale),
      paymentReference: paymentReferenceFor(tenant.id, subscription),
    };
  }

  private amountForCycle(plan: Plan, cycle: SubscriptionBillingCycle): number {
    const rawAmount =
      cycle === SubscriptionBillingCycle.MONTHLY
        ? plan.monthlyPrice
        : cycle === SubscriptionBillingCycle.ANNUAL
          ? plan.annualPrice
          : null;
    const amount = rawAmount === null ? Number.NaN : Number(rawAmount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new InternalServerErrorException('The subscription price is invalid');
    }
    return amount;
  }
}

function bankInstructionsFor(locale: Locale): string {
  const variable =
    locale === Locale.AR
      ? 'KEMFAI_BANK_TRANSFER_INSTRUCTIONS_AR'
      : 'KEMFAI_BANK_TRANSFER_INSTRUCTIONS_EN';
  const instructions = process.env[variable]?.trim();
  if (!instructions) {
    throw new ServiceUnavailableException(
      `Bank transfer instructions are not configured for locale ${locale}`,
    );
  }
  return instructions;
}

function paymentReferenceFor(tenantId: string, subscription: Subscription): string {
  return `KEMFAI-${tenantId}-${subscription.id}-${subscription.currentPeriodStart}`;
}
