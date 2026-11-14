import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { RequireFeatureFlag } from '../../../common/decorators/feature-flag.decorator';
import { TenantScopedRequest } from '../../../common/tenant-context/tenant-context.model';
import {
  DimensionDefinitionCreateDto,
  DimensionDefinitionUpdateDto,
  DimensionRuleCreateDto,
  DimensionRuleUpdateDto,
  DimensionValueCreateDto,
  DimensionValueUpdateDto,
} from '../dto/dimension.dto';
import { DimensionsService } from './dimensions.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseActive(value?: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new BadRequestException('DIMENSION_ACTIVE_FILTER_INVALID');
}

function parseLimit(value?: string): number {
  if (value === undefined) return 50;
  if (!/^[1-9][0-9]*$/.test(value)) throw new BadRequestException('DIMENSION_LIMIT_INVALID');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 200)
    throw new BadRequestException('DIMENSION_LIMIT_INVALID');
  return limit;
}

function parseUuid(value: string | undefined, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (!UUID_PATTERN.test(value)) throw new BadRequestException(code);
  return value;
}

function parseTransactionType(value?: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 64)
    throw new BadRequestException('DIMENSION_TRANSACTION_TYPE_FILTER_INVALID');
  return normalized;
}

function parseCursor(value?: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 512) throw new BadRequestException('DIMENSION_CURSOR_INVALID');
  return value;
}

function parseIfMatch(value?: string): number {
  const match = /^"([1-9][0-9]*)"$/.exec(value ?? '');
  if (!match) throw new BadRequestException('IF_MATCH_INVALID');
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) throw new BadRequestException('IF_MATCH_INVALID');
  return version;
}

function setEtag(res: Response, version: number): void {
  res.setHeader('ETag', `"${version}"`);
}

@Controller('v1/accounting/dimension-definitions')
@RequireFeatureFlag('module.accounting_foundation')
export class DimensionDefinitionsController {
  constructor(private readonly dimensions: DimensionsService) {}

  @Get()
  async list(
    @Req() req: TenantScopedRequest,
    @Headers('x-kemfai-company-id') companyId: string,
    @Query('active') active?: string,
  ) {
    return this.dimensions.listDefinitions(req, companyId, { active: parseActive(active) });
  }

  @Post()
  async create(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Body() body: DimensionDefinitionCreateDto,
  ) {
    const result = await this.dimensions.createDefinition(req, companyId, body);
    setEtag(res, result.resource.version);
    return result;
  }

  @Patch(':definitionId')
  async update(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Param('definitionId', new ParseUUIDPipe()) definitionId: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: DimensionDefinitionUpdateDto,
  ) {
    const result = await this.dimensions.updateDefinition(
      req,
      companyId,
      definitionId,
      parseIfMatch(ifMatch),
      body,
    );
    setEtag(res, result.resource.version);
    return result;
  }
}

@Controller('v1/accounting/dimension-values')
@RequireFeatureFlag('module.accounting_foundation')
export class DimensionValuesController {
  constructor(private readonly dimensions: DimensionsService) {}

  @Get()
  async list(
    @Req() req: TenantScopedRequest,
    @Headers('x-kemfai-company-id') companyId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('definitionId') definitionId?: string,
    @Query('active') active?: string,
  ) {
    return this.dimensions.listValues(req, companyId, {
      cursor: parseCursor(cursor),
      limit: parseLimit(limit),
      definitionId: parseUuid(definitionId, 'DIMENSION_DEFINITION_ID_FILTER_INVALID'),
      active: parseActive(active),
    });
  }

  @Post()
  async create(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Body() body: DimensionValueCreateDto,
  ) {
    const result = await this.dimensions.createValue(req, companyId, body);
    setEtag(res, result.resource.version);
    return result;
  }

  @Patch(':valueId')
  async update(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Param('valueId', new ParseUUIDPipe()) valueId: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: DimensionValueUpdateDto,
  ) {
    const result = await this.dimensions.updateValue(
      req,
      companyId,
      valueId,
      parseIfMatch(ifMatch),
      body,
    );
    setEtag(res, result.resource.version);
    return result;
  }
}

@Controller('v1/accounting/dimension-rules')
@RequireFeatureFlag('module.accounting_foundation')
export class DimensionRulesController {
  constructor(private readonly dimensions: DimensionsService) {}

  @Get()
  async list(
    @Req() req: TenantScopedRequest,
    @Headers('x-kemfai-company-id') companyId: string,
    @Query('accountId') accountId?: string,
    @Query('transactionType') transactionType?: string,
    @Query('active') active?: string,
  ) {
    return this.dimensions.listRules(req, companyId, {
      accountId: parseUuid(accountId, 'DIMENSION_ACCOUNT_ID_FILTER_INVALID'),
      transactionType: parseTransactionType(transactionType),
      active: parseActive(active),
    });
  }

  @Post()
  async create(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Body() body: DimensionRuleCreateDto,
  ) {
    const result = await this.dimensions.createRule(req, companyId, body);
    setEtag(res, result.resource.version);
    return result;
  }

  @Patch(':ruleId')
  async update(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Param('ruleId', new ParseUUIDPipe()) ruleId: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: DimensionRuleUpdateDto,
  ) {
    const result = await this.dimensions.updateRule(
      req,
      companyId,
      ruleId,
      parseIfMatch(ifMatch),
      body,
    );
    setEtag(res, result.resource.version);
    return result;
  }
}
