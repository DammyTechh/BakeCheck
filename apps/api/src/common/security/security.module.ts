import { Global, Module } from '@nestjs/common';
import { AccessControlService } from './access-control.service';

/**
 * Global: nearly every feature module performs a resource-scoped access
 * check, and threading an import through each one adds ceremony without
 * adding safety. AccessControlService is stateless, so one shared instance is
 * correct.
 */
@Global()
@Module({
  providers: [AccessControlService],
  exports: [AccessControlService],
})
export class SecurityModule {}
