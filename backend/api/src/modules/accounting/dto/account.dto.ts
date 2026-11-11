import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

export type AccountNodeKind = 'parent' | 'posting';

export class LocalizedNameDto {
  @IsString({ message: 'ACCOUNT_NAME_EN_INVALID' })
  @IsNotEmpty({ message: 'ACCOUNT_NAME_EN_INVALID' })
  @MaxLength(200, { message: 'ACCOUNT_NAME_EN_INVALID' })
  en!: string;

  @IsString({ message: 'ACCOUNT_NAME_AR_INVALID' })
  @IsNotEmpty({ message: 'ACCOUNT_NAME_AR_INVALID' })
  @MaxLength(200, { message: 'ACCOUNT_NAME_AR_INVALID' })
  ar!: string;
}

export class AccountCreateDto {
  @IsString({ message: 'ACCOUNT_CODE_INVALID' })
  @IsNotEmpty({ message: 'ACCOUNT_CODE_INVALID' })
  @MaxLength(64, { message: 'ACCOUNT_CODE_INVALID' })
  code!: string;

  @IsDefined({ message: 'ACCOUNT_NAME_INVALID' })
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name!: LocalizedNameDto;

  @IsString({ message: 'ACCOUNT_TYPE_INVALID' })
  @IsNotEmpty({ message: 'ACCOUNT_TYPE_INVALID' })
  @MaxLength(64, { message: 'ACCOUNT_TYPE_INVALID' })
  accountType!: string;

  @IsIn(['parent', 'posting'], { message: 'ACCOUNT_NODE_KIND_INVALID' })
  nodeKind!: AccountNodeKind;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID(undefined, { message: 'ACCOUNT_PARENT_ID_INVALID' })
  parentId?: string | null;

  @IsOptional()
  @IsBoolean({ message: 'ACCOUNT_ACTIVE_INVALID' })
  active?: boolean;
}

const ACCOUNT_UPDATE_FIELDS = [
  'code',
  'name',
  'accountType',
  'nodeKind',
  'parentId',
  'active',
] as const;

@ValidatorConstraint({ name: 'accountUpdateNotEmpty', async: false })
class AccountUpdateNotEmptyConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args?: ValidationArguments): boolean {
    if (!args) return false;
    const update = args.object as Record<string, unknown>;
    return ACCOUNT_UPDATE_FIELDS.some((field) =>
      Object.prototype.hasOwnProperty.call(update, field),
    );
  }

  defaultMessage(): string {
    return 'ACCOUNT_UPDATE_EMPTY';
  }
}

export class AccountUpdateDto {
  @Validate(AccountUpdateNotEmptyConstraint)
  private readonly _notEmpty?: never;

  @IsOptional()
  @IsString({ message: 'ACCOUNT_CODE_INVALID' })
  @IsNotEmpty({ message: 'ACCOUNT_CODE_INVALID' })
  @MaxLength(64, { message: 'ACCOUNT_CODE_INVALID' })
  code?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LocalizedNameDto)
  name?: LocalizedNameDto;

  @IsOptional()
  @IsString({ message: 'ACCOUNT_TYPE_INVALID' })
  @IsNotEmpty({ message: 'ACCOUNT_TYPE_INVALID' })
  @MaxLength(64, { message: 'ACCOUNT_TYPE_INVALID' })
  accountType?: string;

  @IsOptional()
  @IsIn(['parent', 'posting'], { message: 'ACCOUNT_NODE_KIND_INVALID' })
  nodeKind?: AccountNodeKind;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID(undefined, { message: 'ACCOUNT_PARENT_ID_INVALID' })
  parentId?: string | null;

  @IsOptional()
  @IsBoolean({ message: 'ACCOUNT_ACTIVE_INVALID' })
  active?: boolean;
}

export interface VersionedResourceDto {
  id: string;
  companyId: string;
  version: number;
  active: boolean;
}

export interface AccountDto extends VersionedResourceDto {
  code: string;
  name: LocalizedNameDto;
  accountType: string;
  nodeKind: AccountNodeKind;
  parentId?: string | null;
  selectableForDraftLines: boolean;
}

export interface AccountPageDto {
  items: AccountDto[];
  nextCursor?: string | null;
}

export interface MutationReceiptDto {
  operationId: string;
  auditEventId: string;
  correlationId: string;
  replayed: boolean;
}

export interface MutationAccountResultDto extends MutationReceiptDto {
  resource: AccountDto;
}
