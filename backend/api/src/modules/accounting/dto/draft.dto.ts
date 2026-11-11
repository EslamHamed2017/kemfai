import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  isDateString,
} from 'class-validator';
import { LocalizedNameDto, MutationReceiptDto } from './account.dto';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

@ValidatorConstraint({ name: 'propertyPresent', async: false })
class PropertyPresentConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return Object.prototype.hasOwnProperty.call(args.object, args.property);
  }
}

@ValidatorConstraint({ name: 'fxRateReference', async: false })
class FxRateReferenceConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const line = args.object as DraftLineWriteDto;
    const foreign = line.transactionCurrencyCode !== line.companyBaseCurrencyCode;
    return foreign
      ? typeof value === 'string' && value.length >= 1 && value.length <= 200
      : value === null;
  }

  defaultMessage(args: ValidationArguments): string {
    const line = args.object as DraftLineWriteDto;
    return line.transactionCurrencyCode === line.companyBaseCurrencyCode
      ? 'FX_METADATA_NOT_ALLOWED_FOR_BASE'
      : 'FX_RATE_REFERENCE_REQUIRED';
  }
}

@ValidatorConstraint({ name: 'fxRateEffectiveDate', async: false })
class FxRateEffectiveDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const line = args.object as DraftLineWriteDto;
    const foreign = line.transactionCurrencyCode !== line.companyBaseCurrencyCode;
    return foreign
      ? typeof value === 'string' &&
          DATE_PATTERN.test(value) &&
          isDateString(value, { strict: true })
      : value === null;
  }

  defaultMessage(args: ValidationArguments): string {
    const line = args.object as DraftLineWriteDto;
    return line.transactionCurrencyCode === line.companyBaseCurrencyCode
      ? 'FX_METADATA_NOT_ALLOWED_FOR_BASE'
      : 'FX_RATE_EFFECTIVE_DATE_REQUIRED';
  }
}

export class DimensionAssignmentWriteDto {
  @IsUUID(undefined, { message: 'DRAFT_DIMENSION_DEFINITION_ID_INVALID' })
  definitionId!: string;

  @IsUUID(undefined, { message: 'DRAFT_DIMENSION_VALUE_ID_INVALID' })
  valueId!: string;
}

export class SourceReferenceDto {
  @IsString({ message: 'DRAFT_SOURCE_TYPE_INVALID' })
  @MaxLength(64, { message: 'DRAFT_SOURCE_TYPE_INVALID' })
  type!: string;

  @IsUUID(undefined, { message: 'DRAFT_SOURCE_ID_INVALID' })
  id!: string;
}

export class DraftLineWriteDto {
  @IsUUID(undefined, { message: 'DRAFT_LINE_ID_INVALID' })
  id!: string;

  @IsInt({ message: 'DRAFT_SEQUENCE_INVALID' })
  @Min(1, { message: 'DRAFT_SEQUENCE_INVALID' })
  sequence!: number;

  @IsUUID(undefined, { message: 'DRAFT_ACCOUNT_ID_INVALID' })
  accountId!: string;

  @IsOptional()
  @IsString({ message: 'DRAFT_LINE_DESCRIPTION_INVALID' })
  @MaxLength(500, { message: 'DRAFT_LINE_DESCRIPTION_INVALID' })
  description?: string;

  @IsString({ message: 'DRAFT_TRANSACTION_CURRENCY_INVALID' })
  @Matches(CURRENCY_PATTERN, { message: 'DRAFT_TRANSACTION_CURRENCY_INVALID' })
  transactionCurrencyCode!: string;

  @IsInt({ message: 'DRAFT_TRANSACTION_PRECISION_INVALID' })
  @Min(0, { message: 'DRAFT_TRANSACTION_PRECISION_INVALID' })
  @Max(12, { message: 'DRAFT_TRANSACTION_PRECISION_INVALID' })
  transactionPrecision!: number;

  @IsString({ message: 'DRAFT_TRANSACTION_METADATA_VERSION_INVALID' })
  @IsNotEmpty({ message: 'DRAFT_TRANSACTION_METADATA_VERSION_INVALID' })
  @MaxLength(128, { message: 'DRAFT_TRANSACTION_METADATA_VERSION_INVALID' })
  transactionCurrencyMetadataVersion!: string;

  @IsString({ message: 'DRAFT_BASE_CURRENCY_INVALID' })
  @Matches(CURRENCY_PATTERN, { message: 'DRAFT_BASE_CURRENCY_INVALID' })
  companyBaseCurrencyCode!: string;

  @IsInt({ message: 'DRAFT_BASE_PRECISION_INVALID' })
  @Min(0, { message: 'DRAFT_BASE_PRECISION_INVALID' })
  @Max(12, { message: 'DRAFT_BASE_PRECISION_INVALID' })
  basePrecision!: number;

  @IsString({ message: 'DRAFT_BASE_METADATA_VERSION_INVALID' })
  @IsNotEmpty({ message: 'DRAFT_BASE_METADATA_VERSION_INVALID' })
  @MaxLength(128, { message: 'DRAFT_BASE_METADATA_VERSION_INVALID' })
  baseCurrencyMetadataVersion!: string;

  @IsInt({ message: 'DRAFT_CURRENCY_CONFIGURATION_VERSION_INVALID' })
  @Min(1, { message: 'DRAFT_CURRENCY_CONFIGURATION_VERSION_INVALID' })
  currencyConfigurationVersion!: number;

  @IsString({ message: 'DRAFT_DECIMAL_INVALID' })
  @Matches(DECIMAL_PATTERN, { message: 'DRAFT_DECIMAL_INVALID' })
  @MaxLength(80, { message: 'DRAFT_DECIMAL_INVALID' })
  transactionDebit!: string;

  @IsString({ message: 'DRAFT_DECIMAL_INVALID' })
  @Matches(DECIMAL_PATTERN, { message: 'DRAFT_DECIMAL_INVALID' })
  @MaxLength(80, { message: 'DRAFT_DECIMAL_INVALID' })
  transactionCredit!: string;

  @IsString({ message: 'DRAFT_DECIMAL_INVALID' })
  @Matches(DECIMAL_PATTERN, { message: 'DRAFT_DECIMAL_INVALID' })
  @MaxLength(80, { message: 'DRAFT_DECIMAL_INVALID' })
  baseDebit!: string;

  @IsString({ message: 'DRAFT_DECIMAL_INVALID' })
  @Matches(DECIMAL_PATTERN, { message: 'DRAFT_DECIMAL_INVALID' })
  @MaxLength(80, { message: 'DRAFT_DECIMAL_INVALID' })
  baseCredit!: string;

  @Validate(PropertyPresentConstraint, { message: 'FX_RATE_REFERENCE_REQUIRED' })
  @Validate(FxRateReferenceConstraint)
  rateReference!: string | null;

  @Validate(PropertyPresentConstraint, { message: 'FX_RATE_EFFECTIVE_DATE_REQUIRED' })
  @Validate(FxRateEffectiveDateConstraint)
  rateEffectiveDate!: string | null;

  @IsArray({ message: 'DRAFT_DIMENSIONS_INVALID' })
  @ArrayUnique((assignment: DimensionAssignmentWriteDto) => assignment.definitionId, {
    message: 'DRAFT_DIMENSION_DEFINITION_DUPLICATE',
  })
  @ValidateNested({ each: true })
  @Type(() => DimensionAssignmentWriteDto)
  dimensions!: DimensionAssignmentWriteDto[];
}

export class DraftWriteDto {
  @IsUUID(undefined, { message: 'DRAFT_JOURNAL_ID_INVALID' })
  journalId!: string;

  @IsString({ message: 'DRAFT_ACCOUNTING_DATE_INVALID' })
  @Matches(DATE_PATTERN, { message: 'DRAFT_ACCOUNTING_DATE_INVALID' })
  @IsDateString({ strict: true }, { message: 'DRAFT_ACCOUNTING_DATE_INVALID' })
  accountingDate!: string;

  @IsString({ message: 'DRAFT_DESCRIPTION_INVALID' })
  @MaxLength(500, { message: 'DRAFT_DESCRIPTION_INVALID' })
  description!: string;

  @IsIn(['manual_journal'], { message: 'DRAFT_TRANSACTION_TYPE_INVALID' })
  transactionType!: 'manual_journal';

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @ValidateNested()
  @Type(() => SourceReferenceDto)
  source?: SourceReferenceDto | null;

  @IsArray({ message: 'DRAFT_LINES_INVALID' })
  @ArrayMaxSize(1000, { message: 'DRAFT_LINES_INVALID' })
  @ValidateNested({ each: true })
  @Type(() => DraftLineWriteDto)
  lines!: DraftLineWriteDto[];
}

export interface DimensionAssignmentDto extends DimensionAssignmentWriteDto {
  definitionName: LocalizedNameDto;
  valueName: LocalizedNameDto;
  active: boolean;
}

export interface DraftLineDto extends Omit<DraftLineWriteDto, 'dimensions'> {
  accountCode: string;
  accountName: LocalizedNameDto;
  dimensions: DimensionAssignmentDto[];
}

export type DraftValidationState = 'not_validated' | 'stale' | 'valid_for_draft' | 'invalid';
export type NoLedgerEffect = 'none';

export interface JournalDraftDto {
  id: string;
  companyId: string;
  version: number;
  status: 'draft';
  journalId: string;
  accountingDate: string;
  description: string;
  transactionType: 'manual_journal';
  source?: SourceReferenceDto | null;
  lines: DraftLineDto[];
  validationState: DraftValidationState;
  ledgerEffect: NoLedgerEffect;
}

export interface DraftPageDto {
  items: JournalDraftDto[];
  nextCursor?: string | null;
}

export interface DraftMutationResultDto extends MutationReceiptDto {
  resource: JournalDraftDto;
  ledgerEffect: NoLedgerEffect;
}

export type ValidationIssueCode =
  | 'ACCOUNT_NOT_POSTING'
  | 'ACCOUNT_INACTIVE'
  | 'JOURNAL_INACTIVE'
  | 'CURRENCY_DISABLED'
  | 'AMOUNT_SCALE_EXCEEDS_METADATA'
  | 'FX_RATE_REFERENCE_REQUIRED'
  | 'FX_RATE_EFFECTIVE_DATE_REQUIRED'
  | 'FX_METADATA_NOT_ALLOWED_FOR_BASE'
  | 'DEBIT_CREDIT_INVALID'
  | 'BASE_TOTALS_UNBALANCED'
  | 'DIMENSION_REQUIRED'
  | 'DIMENSION_PROHIBITED'
  | 'DIMENSION_INACTIVE'
  | 'DIMENSION_OUT_OF_SCOPE'
  | 'CONFIGURATION_STALE'
  | 'POLICY_APPROVAL_REQUIRED'
  | 'ACCOUNT_STALE'
  | 'JOURNAL_OUT_OF_SCOPE'
  | 'JOURNAL_STALE'
  | 'CURRENCY_CONFIGURATION_OUT_OF_SCOPE'
  | 'CURRENCY_METADATA_STALE'
  | 'DRAFT_DECIMAL_INVALID'
  | 'DEBIT_CREDIT_EXCLUSIVE'
  | 'BASE_CURRENCY_FX_PROVENANCE_FORBIDDEN';

export interface ValidationIssueDto {
  code: ValidationIssueCode;
  messageKey: string;
  messageParams?: Record<string, unknown>;
  lineId?: string | null;
  resourceId?: string | null;
  field?: string | null;
}

export interface CurrencyConfigurationSnapshotDto {
  currencyCode: string;
  configurationVersion: number;
  nativeMetadataVersion: string;
  nativeDecimalPlaces: number;
}

export interface ConfigurationSnapshotDto {
  accounts: Record<string, number>;
  dimensionRules: Record<string, number>;
  journal: { id: string; version: number };
  currencies: Record<string, CurrencyConfigurationSnapshotDto>;
}

export type ValidationCheck =
  | 'scope'
  | 'account_activity_and_kind'
  | 'journal_activity'
  | 'currency_completeness'
  | 'exact_money_metadata'
  | 'fx_provenance'
  | 'metadata_scale_policy'
  | 'debit_credit_shape'
  | 'dimension_rules'
  | 'configuration_versions'
  | 'base_arithmetic';

export interface DraftValidationResultDto {
  id: string;
  draftId: string;
  draftVersion: number;
  status: 'valid_for_draft' | 'invalid';
  ledgerEffect: NoLedgerEffect;
  checksPerformed: ValidationCheck[];
  errors: ValidationIssueDto[];
  warnings: ValidationIssueDto[];
  policyBlockers: ValidationIssueDto[];
  companyBaseCurrencyCode: string;
  basePrecision: number;
  baseDebitTotal: string;
  baseCreditTotal: string;
  configurationSnapshot: ConfigurationSnapshotDto;
  validatedAt: string;
}

export interface ValidationMutationResultDto extends MutationReceiptDto {
  result: DraftValidationResultDto;
  ledgerEffect: NoLedgerEffect;
}
