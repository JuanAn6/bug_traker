import {
  type CanActivate, type ExecutionContext, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../decorators/public.decorator';
import type { RequestWithUser } from '../decorators/current-user.decorator';
import { AuthService } from '../../modules/auth/auth.service';
import { TokenService } from '../../modules/auth/token.service';

interface BearerRequest extends RequestWithUser {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Registered globally; @Public() opts a route out.
 *
 * Verifying the signature is not enough. The user is re-loaded on every request so that a
 * disabled account, a deleted account or a bumped tokenVersion takes effect immediately
 * rather than at the next 15-minute expiry. That is one indexed read per request, and it is
 * the check the frontend gets for free by recomputing Auth.user() from the store — where
 * `u?.enabled ? u : null` means disabling somebody logs them out on their next action.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<BearerRequest>();
    const header = request.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : undefined;
    if (!token) throw new UnauthorizedException('login.invalid');

    let claims;
    try {
      claims = await this.tokens.verifyAccessToken(token);
    } catch {
      throw new UnauthorizedException('login.invalid');
    }

    const user = await this.auth.resolve(claims);
    if (!user) throw new UnauthorizedException('login.invalid');

    request.authUser = user;
    return true;
  }
}
