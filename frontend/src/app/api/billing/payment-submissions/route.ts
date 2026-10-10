import {
  getPaymentSubmissions,
  postPaymentSubmission,
} from '@/lib/auth/billing-bff';

export const GET = () => getPaymentSubmissions();
export const POST = (request: Request) => postPaymentSubmission(request);
