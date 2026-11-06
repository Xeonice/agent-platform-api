import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UpgradeSecurity } from '../access-passcode/upgrade-security.service';
import { UpgradeControlAttachment } from './upgrade-control-attachment';

/** Only fixed local startup inputs are accepted. This is not a migration or
 * Entry delegation executor and never activates independent authority. */
@Controller('internal/upgrade-control-attachment')
export class UpgradeControlAttachmentController {
  constructor(
    private readonly attachment: UpgradeControlAttachment,
    private readonly security: UpgradeSecurity,
  ) {}
  private authorize(req: Request): void {
    this.security.internal(req, this.attachment.store.instanceId);
  }
  @Get() status(@Req() req: Request) {
    this.authorize(req);
    return this.attachment.status();
  }
  @Post('freeze') freeze(@Req() req: Request, @Body() input: unknown) {
    this.authorize(req);
    return this.attachment.freeze(input);
  }
  @Post('attach') attach(@Req() req: Request, @Body() input: unknown) {
    this.authorize(req);
    return this.attachment.attach(input);
  }
}
