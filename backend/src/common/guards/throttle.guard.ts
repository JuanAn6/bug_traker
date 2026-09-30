import {
  type CanActivate, type ExecutionContext, HttpException, HttpStatus, Inject, Injectable,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Env } from '../../core/config/env.schema';
import { CACHE_PORT, type CachePort } from '../../core/ports/cache.port';
import type { RequestWithUser } from '../decorators/current-user.decorator';

export const THROTTLE = 'throttle';

export interface ThrottleOptions {
  /** Distinguishes buckets when several routes share the guard. */
  name: string;
  /** Requests allowed inside the window. Falls back to the configured login limit. */
  limit?: number;
  windowMs?: number;
  /**
   * Also count per subject taken from the body — the username on a login.
   *
   * Counting by IP alone is the wrong shape for credential stuffing: an attacker spreads one IP
   * across many accounts, while an office behind a single NAT spreads many people across one IP.
   * So both are counted, and the per-subject bucket is the one that stops a password list.
   */
  subjectFrom?: string;
}

/**
 * A tighter bucket for the few routes worth attacking.
 *
 * The global @fastify/rate-limit ceiling is deliberately generous — it exists to stop runaway
 * clients, not attackers. This is the targeted one: login and refresh are unauthenticated, do
 * argon2 work on every call, and are the obvious place to try a password list.
 *
 * It counts through CachePort rather than a local Map, so moving CachePort to Redis makes the
 * limit apply across instances instead of per process — which is the difference between a real
 * limit and one that multiplies by however many containers are running.
 */
export const Throttle = (options: ThrottleOptions) => SetMetadata(THROTTLE, options);

@Injectable()
export class ThrottleGuard implements CanActivate {
  private readonly defaultLimit: number;
  private readonly defaultWindowMs: number;

  constructor(
    private readonly reflector: Reflector,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    config: ConfigService<Env, true>,
  ) {
    this.defaultLimit = config.get('THROTTLE_LOGIN_MAX', { infer: true });
    this.defaultWindowMs = config.get('THROTTLE_LOGIN_WINDOW_MS', { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<ThrottleOptions | undefined>(THROTTLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const request = context.switchToHttp().getRequest<
      RequestWithUser & { ip?: string; body?: Record<string, unknown> }
    >();
    const limit = options.limit ?? this.defaultLimit;
    const windowMs = options.windowMs ?? this.defaultWindowMs;

    const buckets = [
      request.authUser ? `u:${request.authUser.id}` : `ip:${request.ip ?? 'unknown'}`,
    ];
    if (options.subjectFrom) {
      const subject = request.body?.[options.subjectFrom];
      if (typeof subject === 'string' && subject.trim()) {
        buckets.push(`s:${subject.trim().toLowerCase()}`);
      }
    }

    for (const bucket of buckets) {
      const key = `throttle:${options.name}:${bucket}`;
      const hits = (await this.cache.get<number>(key)) ?? 0;
      if (hits >= limit) {
        throw new HttpException(
          { statusCode: 429, code: 'errors.tooManyRequests', message: 'Too many requests' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      // A fixed window, not a sliding one: an attacker can burst across a boundary, but the point
      // is to make a password list impractical, and a fixed window does that for a fraction of the
      // bookkeeping. The TTL is the reset.
      await this.cache.set(key, hits + 1, windowMs);
    }
    return true;
  }
}
