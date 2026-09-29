import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '../../modules/auth/auth.types';

export interface RequestWithUser {
  authUser?: AuthUser;
}

/**
 * The authenticated user, or one of its fields: `@CurrentUser()` / `@CurrentUser('id')`.
 *
 * Non-null by construction — JwtAuthGuard runs first and rejects the request otherwise — so
 * handlers do not need a null check. A @Public() route must not use it.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    const user = request.authUser;
    if (!user) {
      throw new Error('@CurrentUser() used on a route without JwtAuthGuard');
    }
    return field ? user[field] : user;
  },
);
