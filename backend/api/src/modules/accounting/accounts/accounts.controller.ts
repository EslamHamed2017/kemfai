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
import { AccountCreateDto, AccountUpdateDto } from '../dto/account.dto';
import { AccountsService } from './accounts.service';

@Controller('v1/accounting/accounts')
@RequireFeatureFlag('module.accounting_foundation')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Headers('x-kemfai-company-id') companyId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string,
    @Query('active') rawActive?: string,
    @Query('nodeKind') rawNodeKind?: string,
    @Query('search') search?: string,
  ) {
    return this.accounts.list(req, companyId, {
      cursor,
      limit: this.parseLimit(rawLimit),
      active: this.parseActive(rawActive),
      nodeKind: this.parseNodeKind(rawNodeKind),
      search: this.parseSearch(search),
    });
  }

  @Post()
  async create(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Body() body: AccountCreateDto,
  ) {
    const result = await this.accounts.create(req, companyId, body);
    this.setEtag(res, result.resource.version);
    return result;
  }

  @Get(':accountId')
  async get(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
  ) {
    const account = await this.accounts.get(req, companyId, accountId);
    this.setEtag(res, account.version);
    return account;
  }

  @Patch(':accountId')
  async update(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: AccountUpdateDto,
  ) {
    const result = await this.accounts.update(
      req,
      companyId,
      accountId,
      this.parseIfMatch(ifMatch),
      body,
    );
    this.setEtag(res, result.resource.version);
    return result;
  }

  private parseLimit(value?: string): number {
    if (value === undefined) return 50;
    if (!/^[1-9][0-9]*$/.test(value)) throw new BadRequestException('ACCOUNT_LIMIT_INVALID');
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit > 200)
      throw new BadRequestException('ACCOUNT_LIMIT_INVALID');
    return limit;
  }

  private parseActive(value?: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new BadRequestException('ACCOUNT_ACTIVE_FILTER_INVALID');
  }

  private parseNodeKind(value?: string): 'parent' | 'posting' | undefined {
    if (value === undefined) return undefined;
    if (value === 'parent' || value === 'posting') return value;
    throw new BadRequestException('ACCOUNT_NODE_KIND_FILTER_INVALID');
  }

  private parseSearch(value?: string): string | undefined {
    if (value === undefined) return undefined;
    const search = value.trim();
    if (!search || search.length > 100) throw new BadRequestException('ACCOUNT_SEARCH_INVALID');
    return search;
  }

  private parseIfMatch(value?: string): number {
    const match = /^"([1-9][0-9]*)"$/.exec(value ?? '');
    if (!match) throw new BadRequestException('IF_MATCH_INVALID');
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version)) throw new BadRequestException('IF_MATCH_INVALID');
    return version;
  }

  private setEtag(res: Response, version: number): void {
    res.setHeader('ETag', `"${version}"`);
  }
}
