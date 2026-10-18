import { IsDateString, IsEnum } from 'class-validator';
import { SupportAccessGranteeRole } from '../entities/support-access-grant.entity';

export class CreateSupportAccessGrantDto {
  @IsEnum({ Support: SupportAccessGranteeRole.SUPPORT })
  granteeRole: SupportAccessGranteeRole.SUPPORT;

  @IsDateString({ strict: true })
  expiresAt: string;
}
