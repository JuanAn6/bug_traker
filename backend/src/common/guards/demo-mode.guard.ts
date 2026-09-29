import {
  type CanActivate, type ExecutionContext, Injectable, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';

/**
 * Hides a route entirely unless DEMO_MODE is on.
 *
 * 404 rather than 403: the demo-user list and the destructive admin endpoints should not even
 * announce that they exist in a real deployment.
 */
@Injectable()
export class DemoModeGuard implements CanActivate {
  private readonly enabled: boolean;

  constructor(config: ConfigService<Env, true>) {
    this.enabled = config.get('DEMO_MODE', { infer: true });
  }

  canActivate(_context: ExecutionContext): boolean {
    if (!this.enabled) throw new NotFoundException();
    return true;
  }
}
