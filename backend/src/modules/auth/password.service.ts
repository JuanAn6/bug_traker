import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id, with the parameters pinned in one place.
 *
 * @node-rs/argon2's `Algorithm` enum is erased at runtime (it inspects as `{}`), so the
 * numeric discriminant is passed instead of the named member. 2 is Argon2id — which also
 * happens to be the library default, but relying on a default for a security parameter is
 * how it silently changes under you.
 */
const ARGON2ID = 2;
const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // 19 MiB — OWASP's minimum for argon2id
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hash(plain, OPTIONS);
  }

  /**
   * Never throws for a wrong password — a malformed or foreign hash is an authentication
   * failure, not a 500. Callers must not distinguish the two in what they return.
   */
  async verify(storedHash: string, plain: string): Promise<boolean> {
    try {
      return await verify(storedHash, plain, OPTIONS);
    } catch {
      return false;
    }
  }

  /** True when a stored hash was produced with weaker parameters and should be upgraded. */
  needsRehash(storedHash: string): boolean {
    const m = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)/.exec(storedHash);
    if (!m) return true;
    return (
      Number(m[1]) < OPTIONS.memoryCost ||
      Number(m[2]) < OPTIONS.timeCost ||
      Number(m[3]) < OPTIONS.parallelism
    );
  }
}
