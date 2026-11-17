import { Global, Module } from '@nestjs/common';
import { BrowserGateway } from './browser.gateway.js';
import { ChannelAuthorizer } from './channel-authorizer.js';
import { RealtimeService } from './realtime.service.js';
import { UpgradeRouter } from './upgrade-router.js';

@Global()
@Module({
  providers: [UpgradeRouter, RealtimeService, ChannelAuthorizer, BrowserGateway],
  exports: [UpgradeRouter, RealtimeService, BrowserGateway],
})
export class RealtimeModule {}
