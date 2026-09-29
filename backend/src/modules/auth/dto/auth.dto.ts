import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  username!: string;

  /**
   * Required as a field, but may be empty: with DEMO_MODE on the seeded accounts have no hash
   * and accept anything, which is what the current login page sends (its password box is not
   * marked required).
   */
  @IsString()
  @MaxLength(256)
  password!: string;

  /**
   * Only affects how long the refresh cookie lives in the browser. The token's own lifetime is
   * fixed server-side, so a client cannot extend its session by asking.
   */
  @IsOptional()
  @IsBoolean()
  remember?: boolean;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(256)
  currentPassword!: string;

  /** The account page enforces 8 characters client-side; the service enforces it again. */
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  newPassword!: string;
}
