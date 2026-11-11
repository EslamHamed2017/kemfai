import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { LocalizedNameDto, MutationReceiptDto, VersionedResourceDto } from './account.dto';

const JOURNAL_UPDATE_FIELDS = ['code', 'name', 'active'] as const;

@ValidatorConstraint({ name: 'journalUpdateNotEmpty', async: false })
class JournalUpdateNotEmptyConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const update = args.object as Record<string, unknown>;
    return JOURNAL_UPDATE_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(update, field),
    );
  }

  defaultMessage(): string {
    return 'JOURNAL_UPDATE_EMPTY';
  }
}

@ValidatorConstraint({ name: 'immutableRequestFieldAbsent', async: false })
class ImmutableRequestFieldAbsentConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return !Object.prototype.hasOwnProperty.call(args.object, args.property);
  }
}

export type JournalType = 'general';

export class JournalCreateDto {
  @IsString({ message: 'JOURNAL_CODE_INVALID' })
  @IsNotEmpty({ message: 'JOURNAL_CODE_INVALID' })
  @MaxLength(16, { message: 'JOURNAL_CODE_INVALID' })
  code!: string;

  @IsDefined({ message: 'JOURNAL_NAME_INVALID' })
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name!: LocalizedNameDto;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['general'], { message: 'JOURNAL_TYPE_INVALID' })
  journalType?: JournalType;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean({ message: 'JOURNAL_ACTIVE_INVALID' })
  active?: boolean;
}

export class JournalUpdateDto {
  @Validate(JournalUpdateNotEmptyConstraint)
  private readonly _notEmpty?: never;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString({ message: 'JOURNAL_CODE_INVALID' })
  @IsNotEmpty({ message: 'JOURNAL_CODE_INVALID' })
  @MaxLength(16, { message: 'JOURNAL_CODE_INVALID' })
  code?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name?: LocalizedNameDto;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean({ message: 'JOURNAL_ACTIVE_INVALID' })
  active?: boolean;

  @Validate(ImmutableRequestFieldAbsentConstraint, {
    message: 'JOURNAL_TYPE_IMMUTABLE',
  })
  journalType?: never;
}

export class CurrencyConfigurationPutDto {
  @IsBoolean({ message: 'CURRENCY_ENABLED_INVALID' })
  enabled!: boolean;

  @Validate(ImmutableRequestFieldAbsentConstraint, {
    message: 'CURRENCY_METADATA_IMMUTABLE',
  })
  currencyCode?: never;

  @Validate(ImmutableRequestFieldAbsentConstraint, {
    message: 'CURRENCY_METADATA_IMMUTABLE',
  })
  nativeDecimalPlaces?: never;

  @Validate(ImmutableRequestFieldAbsentConstraint, {
    message: 'CURRENCY_METADATA_IMMUTABLE',
  })
  nativeMetadataVersion?: never;

  @Validate(ImmutableRequestFieldAbsentConstraint, {
    message: 'CURRENCY_METADATA_IMMUTABLE',
  })
  isBase?: never;
}

export interface JournalDto extends VersionedResourceDto {
  code: string;
  name: LocalizedNameDto;
  journalType: JournalType;
  selectableForDrafts: boolean;
}

export interface JournalPageDto {
  items: JournalDto[];
  nextCursor?: string | null;
}

export interface JournalMutationResultDto extends MutationReceiptDto {
  resource: JournalDto;
}

export interface CurrencyConfigurationDto {
  id: string;
  companyId: string;
  version: number;
  currencyCode: string;
  nativeDecimalPlaces: number;
  nativeMetadataVersion: string;
  isBase: boolean;
  enabled: boolean;
}

export interface CurrencyConfigurationPageDto {
  items: CurrencyConfigurationDto[];
  nextCursor?: string | null;
}

export interface CurrencyConfigurationMutationResultDto extends MutationReceiptDto {
  resource: CurrencyConfigurationDto;
}
