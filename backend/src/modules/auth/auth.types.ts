import type { AccessLevel, Density, Theme } from '../../shared/models';

/** What JwtAuthGuard attaches to the request, and what @CurrentUser() hands to a handler. */
export interface AuthUser {
  id: number;
  username: string;
  realName: string;
  accessLevel: AccessLevel;
  /**
   * Eagerly joined: it is one row, and almost every request needs `pageSize` for pagination
   * or `language` for the response. Fetching it lazily would just mean a second query on
   * nearly every path.
   */
  prefs: {
    language: string;
    theme: Theme;
    density: Density;
    defaultProjectId: number | null;
    pageSize: number;
    notesNewestFirst: boolean;
  };
}

export interface AccessTokenClaims {
  sub: number;
  username: string;
  /** Effective global access level, so the threshold guard needs no query for global actions. */
  lvl: AccessLevel;
  /**
   * Mirrors users.tokenVersion. Bumped on password change and on disable, so tokens already
   * issued stop working instead of living out their 15 minutes.
   */
  ver: number;
}

export interface TokenPair {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}
