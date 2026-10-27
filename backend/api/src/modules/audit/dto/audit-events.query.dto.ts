import { IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class AuditEventsQueryDto {
  @IsOptional()
  @IsUUID('4', { message: 'tenantId must be a UUID' })
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  action?: string;
}
