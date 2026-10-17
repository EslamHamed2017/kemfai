import { getBillingReviewQueue } from '@/lib/auth/billing-admin-bff';
export const dynamic = 'force-dynamic';
export const GET = () => getBillingReviewQueue();
