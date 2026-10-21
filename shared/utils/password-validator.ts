/**
 * Password Validation Utility
 * Task 102.12 - Strong Password Policy Enforcement
 *
 * SECURITY: This module implements NIST SP 800-63B compliant password policies
 * with configurable rules for enterprise security requirements.
 */

export interface PasswordValidationResult {
  isValid: boolean;
  errors: string[];
  score: number; // 0-100 strength score
}

export interface PasswordPolicyConfig {
  minLength: number;
  maxLength: number;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireNumber: boolean;
  requireSpecial: boolean;
  maxRepeatingChars: number;
  maxSequentialChars: number;
  disallowCommonPasswords: boolean;
  disallowUserContext: boolean;
}

/**
 * Top 200 most common passwords from security breach databases.
 * SECURITY: These passwords are immediately rejected regardless of complexity.
 */
const COMMON_PASSWORDS = new Set([
  'password', '123456', '12345678', 'qwerty', '111111', '1234567',
  'password1', 'password123', '12345', '1234567890', '123123', '000000',
  'iloveyou', 'sunshine', 'princess', 'admin', 'welcome', 'monkey',
  'login', 'abc123', 'starwars', 'dragon', 'master', 'hello',
  'freedom', 'whatever', 'qazwsx', 'trustno1', 'letmein', 'football',
  'baseball', 'superman', 'batman', 'jordan', 'shadow', 'access',
  'passw0rd', 'p@ssword', 'p@ssw0rd', 'pass1234', 'changeme', 'secret',
  'computer', 'internet', 'qwerty123', 'asdfghjkl', 'zxcvbnm', 'michael',
  'jennifer', 'thomas', 'jessica', 'michelle', 'daniel', 'password2',
  'charlie', 'andrew', 'joshua', 'matthew', 'amanda', 'nicole',
  'ashley', 'robert', 'william', 'elizabeth', 'summer', 'winter',
  'spring', 'autumn', 'soccer', 'hockey', 'basketball', 'tennis',
  'football1', 'baseball1', 'soccer1', 'hockey1', 'ferrari', 'mercedes',
  'corvette', 'mustang', 'bitcoin', 'blockchain', 'crypto', 'password!',
  'p@ss', '1q2w3e4r', '1qaz2wsx', 'qwer1234', 'asdf1234', 'zxcv1234',
  'welcome1', 'welcome123', 'admin123', 'admin1234', 'administrator',
  'root', 'toor', 'guest', 'test', 'test123', 'test1234', 'testing',
  'temp', 'temp123', 'default', 'default123', 'user', 'user123',
  'password12', 'password1234', 'qwerty1', 'qwerty12', 'letmein1',
  'letmein123', 'trustno1!', 'monkey1', 'dragon1', 'master1', 'hello1',
  'sunshine1', 'princess1', 'football2', 'baseball2', 'superman1',
  'batman1', 'jordan1', 'shadow1', 'access1', 'thunder', 'thunder1',
  'hunter', 'hunter1', 'hunter2', 'buster', 'soccer2', 'charlie1',
  'george', 'george1', 'killer', 'killer1', 'pepper', 'pepper1',
  'zaq1zaq1', '!qaz@wsx', 'qazxsw', 'qazxsw123', 'asdfasdf', 'asdf',
  'asdfjkl', '123qwe', 'qwe123', '123abc', 'abc123!', '!@#$%^&*',
  'password!1', 'passw0rd!', 'p@ssw0rd!', 'letmein!', 'welcome!',
  '1234abcd', 'abcd1234', 'p@55w0rd', 'pa$$word', 'pa$$w0rd',
  'azerty', 'azertyuiop', 'iloveyou1', 'iloveyou!', 'love', 'love123',
  'lover', 'lovely', 'happy', 'happy1', 'happy123', 'qwerty!',
  '121212', '123321', '654321', '7777777', '696969', 'password0',
  'password9', 'pass123', 'pass1', 'passpass', 'passw0rd1', 'password01',
  'wrfcoin', 'weather', 'forecast', 'climate', 'blockchain1', 'crypto1',
]);

/**
 * Common keyboard sequences that indicate weak passwords
 */
const KEYBOARD_SEQUENCES = [
  'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm',
  'qazwsx', 'wsxedc', 'edcrfv', 'rfvtgb', '1qaz', '2wsx', '3edc', '4rfv',
  '!qaz', '@wsx', '#edc', '$rfv', 'qaswed', 'qazxsw', 'zaqwsx',
];

/**
 * Sequential patterns to detect
 */
const SEQUENTIAL_PATTERNS = [
  'abc', 'bcd', 'cde', 'def', 'efg', 'fgh', 'ghi', 'hij', 'ijk',
  'jkl', 'klm', 'lmn', 'mno', 'nop', 'opq', 'pqr', 'qrs', 'rst',
  'stu', 'tuv', 'uvw', 'vwx', 'wxy', 'xyz',
  '012', '123', '234', '345', '456', '567', '678', '789', '890',
  '321', '432', '543', '654', '765', '876', '987', '098', '210',
  'cba', 'dcb', 'edc', 'fed', 'gfe', 'hgf', 'ihg', 'jih', 'kji',
];

/**
 * Special characters recognized for password complexity
 */
const SPECIAL_CHARS = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/;

/**
 * Password Validator Class
 * Implements comprehensive password policy enforcement
 */
export class PasswordValidator {
  /**
   * Default password policy following security best practices
   * SECURITY: Minimum 12 characters per NIST SP 800-63B recommendations
   */
  static readonly DEFAULT_POLICY: PasswordPolicyConfig = {
    minLength: 12,
    maxLength: 128,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecial: true,
    maxRepeatingChars: 3,
    maxSequentialChars: 3,
    disallowCommonPasswords: true,
    disallowUserContext: true,
  };

  /**
   * Validate a password against the configured policy
   *
   * @param password - The password to validate
   * @param policy - Optional partial policy config to override defaults
   * @param userContext - Optional user context (email, username) to check against
   * @returns PasswordValidationResult with validity status, errors, and strength score
   */
  static validate(
    password: string,
    policy?: Partial<PasswordPolicyConfig>,
    userContext?: { email?: string; username?: string; address?: string }
  ): PasswordValidationResult {
    const config = { ...PasswordValidator.DEFAULT_POLICY, ...policy };
    const errors: string[] = [];

    // SECURITY: Prevent null/undefined passwords
    if (!password || typeof password !== 'string') {
      return {
        isValid: false,
        errors: ['Password is required'],
        score: 0,
      };
    }

    // Length validation
    if (password.length < config.minLength) {
      errors.push(`Password must be at least ${config.minLength} characters long`);
    }

    if (password.length > config.maxLength) {
      errors.push(`Password must not exceed ${config.maxLength} characters`);
    }

    // Character class requirements
    if (config.requireUppercase && !/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }

    if (config.requireLowercase && !/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }

    if (config.requireNumber && !/\d/.test(password)) {
      errors.push('Password must contain at least one number');
    }

    if (config.requireSpecial && !SPECIAL_CHARS.test(password)) {
      errors.push('Password must contain at least one special character (!@#$%^&*()_+-=[]{};\':"|,.<>/?`~)');
    }

    // Repeating character check
    const repeatingPattern = new RegExp(`(.)\\1{${config.maxRepeatingChars},}`, 'g');
    if (repeatingPattern.test(password)) {
      errors.push(`Password must not contain more than ${config.maxRepeatingChars} repeating characters`);
    }

    // Sequential character check
    if (PasswordValidator.hasSequentialChars(password, config.maxSequentialChars)) {
      errors.push(`Password must not contain more than ${config.maxSequentialChars} sequential characters`);
    }

    // Keyboard sequence check
    if (PasswordValidator.hasKeyboardSequence(password)) {
      errors.push('Password must not contain common keyboard patterns (e.g., qwerty, asdfgh)');
    }

    // Common password check
    if (config.disallowCommonPasswords && PasswordValidator.isCommonPassword(password)) {
      errors.push('Password is too common and easily guessable');
    }

    // User context check (prevent using email, username, or address in password)
    if (config.disallowUserContext && userContext) {
      const contextIssues = PasswordValidator.checkUserContext(password, userContext);
      errors.push(...contextIssues);
    }

    // Calculate strength score
    const score = PasswordValidator.calculateStrength(password);

    return {
      isValid: errors.length === 0,
      errors,
      score,
    };
  }

  /**
   * Calculate password strength score (0-100)
   *
   * @param password - The password to evaluate
   * @returns Numeric strength score from 0 (weakest) to 100 (strongest)
   */
  static calculateStrength(password: string): number {
    if (!password || typeof password !== 'string') {
      return 0;
    }

    let score = 0;

    // Length scoring (up to 30 points)
    // 8 chars = 10 points, 12 chars = 20 points, 16+ chars = 30 points
    if (password.length >= 16) {
      score += 30;
    } else if (password.length >= 12) {
      score += 20;
    } else if (password.length >= 8) {
      score += 10;
    } else {
      score += Math.min(password.length, 5);
    }

    // Character diversity scoring (up to 40 points)
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasNumber = /\d/.test(password);
    const hasSpecial = SPECIAL_CHARS.test(password);

    if (hasLower) score += 10;
    if (hasUpper) score += 10;
    if (hasNumber) score += 10;
    if (hasSpecial) score += 10;

    // Entropy estimation scoring (up to 20 points)
    const uniqueChars = new Set(password).size;
    const uniqueRatio = uniqueChars / password.length;
    score += Math.floor(uniqueRatio * 20);

    // Penalty for common patterns (up to -30 points)
    if (PasswordValidator.isCommonPassword(password)) {
      score -= 30;
    }
    if (PasswordValidator.hasKeyboardSequence(password)) {
      score -= 15;
    }
    if (PasswordValidator.hasSequentialChars(password, 3)) {
      score -= 10;
    }

    // Penalty for repeating characters
    const repeatingMatch = password.match(/(.)\1{2,}/g);
    if (repeatingMatch) {
      score -= repeatingMatch.length * 5;
    }

    // Additional bonus for mixed character types throughout (up to 10 points)
    const segments = password.match(/.{1,4}/g) || [];
    let diverseSegments = 0;
    for (const segment of segments) {
      const types = [
        /[a-z]/.test(segment),
        /[A-Z]/.test(segment),
        /\d/.test(segment),
        SPECIAL_CHARS.test(segment),
      ].filter(Boolean).length;
      if (types >= 2) diverseSegments++;
    }
    score += Math.min(diverseSegments * 2, 10);

    // Ensure score is within bounds
    return Math.max(0, Math.min(100, score));
  }

  /**
   * Check if a new password hash exists in the password history
   * SECURITY: Prevents password reuse attacks
   *
   * @param newPasswordHash - The hash of the new password (already hashed with bcrypt)
   * @param history - Array of previous password hashes
   * @param bcryptCompare - Async compare function (bcrypt.compare)
   * @returns Promise<boolean> - true if password exists in history (should be rejected)
   */
  static async checkPasswordHistory(
    newPassword: string,
    history: string[],
    bcryptCompare: (password: string, hash: string) => Promise<boolean>
  ): Promise<boolean> {
    if (!history || history.length === 0) {
      return false;
    }

    // Check against each historical hash
    for (const historicalHash of history) {
      try {
        const matches = await bcryptCompare(newPassword, historicalHash);
        if (matches) {
          return true; // Password was used before
        }
      } catch {
        // Continue checking other hashes if one fails
        continue;
      }
    }

    return false; // Password is new
  }

  /**
   * Check for sequential characters in password
   */
  private static hasSequentialChars(password: string, maxAllowed: number): boolean {
    const lowerPassword = password.toLowerCase();

    for (const pattern of SEQUENTIAL_PATTERNS) {
      if (pattern.length > maxAllowed && lowerPassword.includes(pattern)) {
        return true;
      }
    }

    // Check for any sequence longer than maxAllowed
    for (let i = 0; i <= password.length - maxAllowed - 1; i++) {
      const slice = password.slice(i, i + maxAllowed + 1).toLowerCase();
      let isAscending = true;
      let isDescending = true;

      for (let j = 1; j < slice.length; j++) {
        const diff = slice.charCodeAt(j) - slice.charCodeAt(j - 1);
        if (diff !== 1) isAscending = false;
        if (diff !== -1) isDescending = false;
      }

      if (isAscending || isDescending) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check for common keyboard patterns
   */
  private static hasKeyboardSequence(password: string): boolean {
    const lowerPassword = password.toLowerCase();

    for (const sequence of KEYBOARD_SEQUENCES) {
      if (lowerPassword.includes(sequence)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if password is in the common passwords list
   */
  private static isCommonPassword(password: string): boolean {
    const lowerPassword = password.toLowerCase();

    // Direct match
    if (COMMON_PASSWORDS.has(lowerPassword)) {
      return true;
    }

    // Check with common substitutions reversed
    const normalized = lowerPassword
      .replace(/@/g, 'a')
      .replace(/\$/g, 's')
      .replace(/0/g, 'o')
      .replace(/1/g, 'i')
      .replace(/3/g, 'e')
      .replace(/4/g, 'a')
      .replace(/5/g, 's')
      .replace(/7/g, 't')
      .replace(/8/g, 'b')
      .replace(/!/g, '')
      .replace(/\d+$/, ''); // Remove trailing numbers

    if (COMMON_PASSWORDS.has(normalized)) {
      return true;
    }

    return false;
  }

  /**
   * Check if password contains user context information
   */
  private static checkUserContext(
    password: string,
    context: { email?: string; username?: string; address?: string }
  ): string[] {
    const errors: string[] = [];
    const lowerPassword = password.toLowerCase();

    if (context.email) {
      const emailParts = context.email.toLowerCase().split('@');
      const localPart = emailParts[0];

      if (localPart && localPart.length >= 3 && lowerPassword.includes(localPart)) {
        errors.push('Password must not contain your email address');
      }
    }

    if (context.username) {
      const lowerUsername = context.username.toLowerCase();
      if (lowerUsername.length >= 3 && lowerPassword.includes(lowerUsername)) {
        errors.push('Password must not contain your username');
      }
    }

    if (context.address) {
      // For wallet addresses, check if any significant portion is used
      const addressPart = context.address.toLowerCase().slice(2, 10); // First 8 chars after 0x
      if (addressPart && lowerPassword.includes(addressPart)) {
        errors.push('Password must not contain parts of your wallet address');
      }
    }

    return errors;
  }

  /**
   * Get human-readable password requirements message
   */
  static getRequirementsMessage(policy?: Partial<PasswordPolicyConfig>): string {
    const config = { ...PasswordValidator.DEFAULT_POLICY, ...policy };
    const requirements: string[] = [];

    requirements.push(`At least ${config.minLength} characters`);

    if (config.requireUppercase) {
      requirements.push('At least one uppercase letter (A-Z)');
    }
    if (config.requireLowercase) {
      requirements.push('At least one lowercase letter (a-z)');
    }
    if (config.requireNumber) {
      requirements.push('At least one number (0-9)');
    }
    if (config.requireSpecial) {
      requirements.push('At least one special character (!@#$%^&*...)');
    }
    if (config.maxRepeatingChars < 4) {
      requirements.push(`No more than ${config.maxRepeatingChars} repeating characters`);
    }
    if (config.disallowCommonPasswords) {
      requirements.push('Must not be a commonly used password');
    }

    return 'Password requirements:\n- ' + requirements.join('\n- ');
  }
}

/**
 * Convenience function for quick password validation with default policy
 */
export function validatePassword(
  password: string,
  userContext?: { email?: string; username?: string; address?: string }
): PasswordValidationResult {
  return PasswordValidator.validate(password, undefined, userContext);
}

/**
 * Convenience function to check if a password meets minimum requirements
 */
export function isPasswordValid(
  password: string,
  userContext?: { email?: string; username?: string; address?: string }
): boolean {
  return PasswordValidator.validate(password, undefined, userContext).isValid;
}
