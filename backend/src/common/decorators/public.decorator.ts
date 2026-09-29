import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:public';

/** Opts a route out of JwtAuthGuard: login, refresh, health, the demo-user list. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
