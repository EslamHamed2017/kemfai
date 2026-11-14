import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { RequireFeatureFlag } from '../../../common/decorators/feature-flag.decorator';
import { TenantScopedRequest } from '../../../common/tenant-context/tenant-context.model';
import { DraftWriteDto } from '../dto/draft.dto';
import { DraftValidationService } from './draft-validation.service';
import { DraftsService } from './drafts.service';

@Controller('v1/accounting/drafts')
@RequireFeatureFlag('module.accounting_foundation')
export class DraftsController {
  constructor(
    private readonly drafts: DraftsService,
    private readonly draftValidation: DraftValidationService,
  ) {}

  @Get()
  list(
    @Req() req: TenantScopedRequest,
    @Headers('x-kemfai-company-id') companyId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string,
  ) {
    return this.drafts.list(req, companyId, {
      cursor,
      limit: this.parseLimit(rawLimit),
    });
  }

  @Post()
  async save(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Body() body: DraftWriteDto,
  ) {
    const result = await this.drafts.save(req, companyId, body);
    this.setEtag(res, result.resource.version);
    return result;
  }

  @Put(':draftId')
  async update(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
    @Headers('if-match') ifMatch: string,
    @Body() body: DraftWriteDto,
  ) {
    const result = await this.drafts.update(
      req,
      companyId,
      draftId,
      this.parseIfMatch(ifMatch),
      body,
    );
    this.setEtag(res, result.resource.version);
    return result;
  }

  @Get(':draftId')
  async get(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
  ) {
    const draft = await this.drafts.get(req, companyId, draftId);
    this.setEtag(res, draft.version);
    return draft;
  }

  @Post(':draftId/validate')
  @HttpCode(200)
  async validate(
    @Req() req: TenantScopedRequest,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-kemfai-company-id') companyId: string,
    @Param('draftId', new ParseUUIDPipe()) draftId: string,
    @Headers('if-match') ifMatch: string,
  ) {
    const result = await this.draftValidation.validate(
      req,
      companyId,
      draftId,
      this.parseIfMatch(ifMatch),
    );
    this.setEtag(res, result.result.draftVersion);
    return result;
  }

  private parseLimit(value?: string): number {
    if (value === undefined) return 50;
    if (!/^[1-9][0-9]*$/.test(value)) throw new BadRequestException('DRAFT_LIMIT_INVALID');
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit > 200)
      throw new BadRequestException('DRAFT_LIMIT_INVALID');
    return limit;
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
