import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';

/**
 * Global: nearly every module writes audit entries, and threading an import
 * through all of them adds noise without adding safety.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
