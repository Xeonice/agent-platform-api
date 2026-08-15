import { Global, Module } from '@nestjs/common';
import { SANDBOX_EVENT_BROADCASTER } from '@platform/contracts';
import { EventsGateway } from './events.gateway';

/**
 * @Global realtime assembly: hosts the `/events` socket.io gateway and binds it as
 * the `SANDBOX_EVENT_BROADCASTER` port (via `useExisting` — ONE instance is both
 * the gateway and the broadcaster). Being @Global lets the sandbox projector
 * (a different module) inject the broadcaster by token.
 */
@Global()
@Module({
  providers: [EventsGateway, { provide: SANDBOX_EVENT_BROADCASTER, useExisting: EventsGateway }],
  exports: [SANDBOX_EVENT_BROADCASTER],
})
export class RealtimeModule {}
