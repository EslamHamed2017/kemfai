import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { LocalizedNameDto, MutationReceiptDto, VersionedResourceDto } from './account.dto';

const DIMENSION_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type DimensionKind = 'built_in' | 'custom' | 'tag';
export type WritableDimensionKind = Exclude<DimensionKind, 'built_in'>;
export type DimensionRequirement = 'required' | 'optional' | 'prohibited';

@ValidatorConstraint({ name: 'dimensionUpdateNotEmpty', async: false })
class DimensionUpdateNotEmptyConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const [fields] = args.constraints as [readonly string[], string];
    const update = args.object as Record<string, unknown>;
    return fields.some((field) => Object.prototype.hasOwnProperty.call(update, field));
  }

  defaultMessage(args: ValidationArguments): string {
    return (args.constraints as [readonly string[], string])[1];
  }
}

@ValidatorConstraint({ name: 'dimensionRuleScope', async: false })
class DimensionRuleScopeConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const rule = args.object as DimensionRuleCreateDto;
    return Boolean(rule.accountId || rule.transactionType);
  }

  defaultMessage(): string {
    return 'DIMENSION_RULE_SCOPE_REQUIRED';
  }
}

export class DimensionDefinitionCreateDto {
  @IsString({ message: 'DIMENSION_KEY_INVALID' })
  @Matches(DIMENSION_KEY_PATTERN, { message: 'DIMENSION_KEY_INVALID' })
  key!: string;

  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name!: LocalizedNameDto;

  @IsOptional()
  @IsIn(['custom', 'tag'], { message: 'DIMENSION_KIND_INVALID' })
  kind?: WritableDimensionKind;

  @IsOptional()
  @IsBoolean({ message: 'DIMENSION_ACTIVE_INVALID' })
  active?: boolean;
}

export class DimensionDefinitionUpdateDto {
  @Validate(DimensionUpdateNotEmptyConstraint, [
    ['name', 'active'],
    'DIMENSION_DEFINITION_UPDATE_EMPTY',
  ])
  private readonly _notEmpty?: never;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name?: LocalizedNameDto;

  @IsOptional()
  @IsBoolean({ message: 'DIMENSION_ACTIVE_INVALID' })
  active?: boolean;
}

export class DimensionValueCreateDto {
  @IsUUID(undefined, { message: 'DIMENSION_DEFINITION_ID_INVALID' })
  definitionId!: string;

  @IsString({ message: 'DIMENSION_VALUE_CODE_INVALID' })
  @IsNotEmpty({ message: 'DIMENSION_VALUE_CODE_INVALID' })
  @MaxLength(64, { message: 'DIMENSION_VALUE_CODE_INVALID' })
  code!: string;

  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name!: LocalizedNameDto;

  @IsOptional()
  @IsBoolean({ message: 'DIMENSION_ACTIVE_INVALID' })
  active?: boolean;
}

export class DimensionValueUpdateDto {
  @Validate(DimensionUpdateNotEmptyConstraint, [
    ['code', 'name', 'active'],
    'DIMENSION_VALUE_UPDATE_EMPTY',
  ])
  private readonly _notEmpty?: never;

  @IsOptional()
  @IsString({ message: 'DIMENSION_VALUE_CODE_INVALID' })
  @IsNotEmpty({ message: 'DIMENSION_VALUE_CODE_INVALID' })
  @MaxLength(64, { message: 'DIMENSION_VALUE_CODE_INVALID' })
  code?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name?: LocalizedNameDto;

  @IsOptional()
  @IsBoolean({ message: 'DIMENSION_ACTIVE_INVALID' })
  active?: boolean;
}

export class DimensionRuleCreateDto {
  @Validate(DimensionRuleScopeConstraint)
  private readonly _scope?: never;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID(undefined, { message: 'DIMENSION_ACCOUNT_ID_INVALID' })
  accountId?: string | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString({ message: 'DIMENSION_TRANSACTION_TYPE_INVALID' })
  @IsNotEmpty({ message: 'DIMENSION_TRANSACTION_TYPE_INVALID' })
  @MaxLength(64, { message: 'DIMENSION_TRANSACTION_TYPE_INVALID' })
  transactionType?: string | null;

  @IsUUID(undefined, { message: 'DIMENSION_DEFINITION_ID_INVALID' })
  dimensionDefinitionId!: string;

  @IsIn(['required', 'optional', 'prohibited'], {
    message: 'DIMENSION_REQUIREMENT_INVALID',
  })
  requirement!: DimensionRequirement;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString({ message: 'DIMENSION_EFFECTIVE_FROM_INVALID' })
  @Matches(DATE_PATTERN, { message: 'DIMENSION_EFFECTIVE_FROM_INVALID' })
  @IsDateString({ strict: true }, { message: 'DIMENSION_EFFECTIVE_FROM_INVALID' })
  effectiveFrom?: string | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString({ message: 'DIMENSION_EFFECTIVE_TO_INVALID' })
  @Matches(DATE_PATTERN, { message: 'DIMENSION_EFFECTIVE_TO_INVALID' })
  @IsDateString({ strict: true }, { message: 'DIMENSION_EFFECTIVE_TO_INVALID' })
  effectiveTo?: string | null;

  @IsOptional()
  @IsBoolean({ message: 'DIMENSION_ACTIVE_INVALID' })
  active?: boolean;
}

export class DimensionRuleUpdateDto {
  @Validate(DimensionUpdateNotEmptyConstraint, [
    ['requirement', 'effectiveFrom', 'effectiveTo', 'active'],
    'DIMENSION_RULE_UPDATE_EMPTY',
  ])
  private readonly _notEmpty?: never;

  @IsOptional()
  @IsIn(['required', 'optional', 'prohibited'], {
    message: 'DIMENSION_REQUIREMENT_INVALID',
  })
  requirement?: DimensionRequirement;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString({ message: 'DIMENSION_EFFECTIVE_FROM_INVALID' })
  @Matches(DATE_PATTERN, { message: 'DIMENSION_EFFECTIVE_FROM_INVALID' })
  @IsDateString({ strict: true }, { message: 'DIMENSION_EFFECTIVE_FROM_INVALID' })
  effectiveFrom?: string | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsString({ message: 'DIMENSION_EFFECTIVE_TO_INVALID' })
  @Matches(DATE_PATTERN, { message: 'DIMENSION_EFFECTIVE_TO_INVALID' })
  @IsDateString({ strict: true }, { message: 'DIMENSION_EFFECTIVE_TO_INVALID' })
  effectiveTo?: string | null;

  @IsOptional()
  @IsBoolean({ message: 'DIMENSION_ACTIVE_INVALID' })
  active?: boolean;
}

export interface DimensionDefinitionDto extends VersionedResourceDto {
  key: string;
  kind: DimensionKind;
  name: LocalizedNameDto;
}

export interface DimensionValueDto extends VersionedResourceDto {
  definitionId: string;
  code: string;
  name: LocalizedNameDto;
}

export interface DimensionRuleDto extends VersionedResourceDto {
  accountId?: string | null;
  transactionType?: string | null;
  dimensionDefinitionId: string;
  requirement: DimensionRequirement;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface DimensionPageDto<T> {
  items: T[];
  nextCursor?: string | null;
}

export interface DimensionMutationResultDto<T> extends MutationReceiptDto {
  resource: T;
}
