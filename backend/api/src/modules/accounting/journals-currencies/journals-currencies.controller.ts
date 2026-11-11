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
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { RequireFeatureFlag } from '../../../common/decorators/feature-flag.decorator';
import { TenantScopedRequest } from '../../../common/tenant-context/tenant-context.model';
import {
  CurrencyConfigurationPutDto,
  JournalCreateDto,
  JournalUpdateDto,
} from '../dto/journal-currency.dto';
import { JournalsCurrenciesService } from './journals-currencies.service';

@Controller('v1/accounting')
@RequireFeatureFlag('module.accounting_foundation')
export class JournalsCurrenciesController {
  constructor(private readonly journalsCurrencies: JournalsCurrenciesService) {}

  @Get('journals')
  listJournals(
    @Req() req: TenantScopedRequest,
    @Headers('x-kemfai-company-id') companyId: string,
    @Query('active') active?: string,
  ) {
    return this.journalsCurrencies.listJournals(req, companyId, {
      active: this.parseBooleanFilter(active, 'JOURNAL_ACTIVE_FILTER_INVALID'),
    });
  }

  @Post('journals')
  async createJournal(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Body() body: JournalCreateDto,
  ) {
    const result = await this.journalsCurrencies.createJournal(req, companyId, body);
    this.setEtag(res, result.resource.version);
    return result;
  }

  @Patch('journals/:journalId')
  async updateJournal(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Param('journalId', new ParseUUIDPipe()) journalId: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: JournalUpdateDto,
  ) {
    const result = await this.journalsCurrencies.updateJournal(
      req,
      companyId,
      journalId,
      this.parseStrongEtag(ifMatch),
      body,
    );
    this.setEtag(res, result.resource.version);
    return result;
  }

  @Get('currencies')
  listCurrencies(
    @Req() req: TenantScopedRequest,
    @Headers('x-kemfai-company-id') companyId: string,
    @Query('enabled') enabled?: string,
  ) {
    return this.journalsCurrencies.listCurrencies(req, companyId, {
      enabled: this.parseBooleanFilter(enabled, 'CURRENCY_ENABLED_FILTER_INVALID'),
    });
  }

  @Put('currencies/:currencyCode')
  async putCurrency(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Param('currencyCode') currencyCode: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: CurrencyConfigurationPutDto,
  ) {
    if (!/^[A-Z]{3}$/.test(currencyCode)) {
      throw new BadRequestException('CURRENCY_CODE_INVALID');
    }
    const precondition = this.parseCurrencyPrecondition(ifMatch);
    const result = await this.journalsCurrencies.putCurrencyConfiguration(
      req,
      companyId,
      currencyCode,
      precondition,
      body,
    );
    res.status(precondition === '*' ? 201 : 200);
    this.setEtag(res, result.resource.version);
    return result;
  }

  private parseBooleanFilter(value: string | undefined, code: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new BadRequestException(code);
  }

  private parseStrongEtag(value?: string): number {
    const match = /^"([1-9][0-9]*)"$/.exec(value ?? '');
    if (!match) throw new BadRequestException('IF_MATCH_INVALID');
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version)) throw new BadRequestException('IF_MATCH_INVALID');
    return version;
  }

  private parseCurrencyPrecondition(value?: string): string {
    if (value === '*') return value;
    this.parseStrongEtag(value);
    return value!;
  }

  private setEtag(res: Response, version: number): void {
    res.setHeader('ETag', `"${version}"`);
  }
}
