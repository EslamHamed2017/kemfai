import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { PlanSummary, PlansService } from './plans.service';

/**
 * Genuinely public surface (FR-016) — exempted from the global BearerAuthGuard chain via
 * @Public() (see public.decorator.ts).
 */
@Controller('public/plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Public()
  @Get()
  async list(): Promise<PlanSummary[]> {
    return this.plansService.listPublishedPlans();
  }
}
