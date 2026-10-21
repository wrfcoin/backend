import bcrypt from 'bcryptjs';
import { AuthMiddleware } from '../middleware/auth-middleware.js';
import {
  PasswordValidator,
  PasswordValidationResult,
} from '../../../../shared/utils/password-validator.js';
import { securityLogger } from '../../../../server/utils/logger.js';

export interface User {
  id: string;
  address: string;
  email?: string;
  role: string;
  passwordHash: string;
  createdAt: Date;
}

export interface LoginRequest {
  address: string;
  password: string;
}

export interface SignupRequest {
  address: string;
  email?: string;
  password: string;
}

export interface AuthResponse {
  user: {
    id: string;
    address: string;
    role: string;
  };
  token: string;
}

/**
 * Authentication service for user management
 * In production, this would connect to a user database
 */
export class AuthService {
  private static users: Map<string, User> = new Map();
  private static readonly DEMO_SEED_FLAG = 'ENABLE_DEMO_USERS';

  /**
   * Register a new user
   */
  static async signup(signupData: SignupRequest): Promise<AuthResponse> {
    const { address, email, password } = signupData;

    // Check if user already exists
    if (AuthService.users.has(address)) {
      throw new Error('User already exists');
    }

    // Validate wallet address format (basic validation)
    if (!address.startsWith('0x') || address.length !== 42) {
      throw new Error('Invalid wallet address format');
    }

    // SECURITY: Validate password against strong password policy (Task 102.12)
    // Implements NIST SP 800-63B compliant password requirements:
    // - Minimum 12 characters
    // - Uppercase, lowercase, numbers, and special characters required
    // - Common passwords blocked
    // - User context (email, address) cannot be part of password
    const passwordValidation: PasswordValidationResult = PasswordValidator.validate(
      password,
      undefined, // Use default policy
      { email, address } // Prevent using personal info in password
    );

    if (!passwordValidation.isValid) {
      // Return all validation errors to help user create a compliant password
      const errorMessage = passwordValidation.errors.join('; ');
      throw new Error(`Password validation failed: ${errorMessage}`);
    }

    // SECURITY: Reject weak passwords even if they pass basic validation
    if (passwordValidation.score < 40) {
      throw new Error(
        'Password is too weak. Please use a stronger combination of characters.'
      );
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const user: User = {
      id: `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      address,
      email,
      role: 'user',
      passwordHash,
      createdAt: new Date(),
    };

    AuthService.users.set(address, user);

    // Generate token
    const token = AuthMiddleware.generateUserToken({
      id: user.id,
      address: user.address,
      role: user.role,
    });

    return {
      user: {
        id: user.id,
        address: user.address,
        role: user.role,
      },
      token,
    };
  }

  /**
   * Authenticate user login
   */
  static async login(loginData: LoginRequest): Promise<AuthResponse> {
    const { address, password } = loginData;

    // Find user
    const user = AuthService.users.get(address);
    if (!user) {
      throw new Error('Invalid credentials');
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      throw new Error('Invalid credentials');
    }

    // Generate token
    const token = AuthMiddleware.generateUserToken({
      id: user.id,
      address: user.address,
      role: user.role,
    });

    return {
      user: {
        id: user.id,
        address: user.address,
        role: user.role,
      },
      token,
    };
  }

  /**
   * Get user by address
   */
  static async getUserByAddress(address: string): Promise<User | null> {
    return AuthService.users.get(address) || null;
  }

  /**
   * Create demo users for testing
   */
  static async seedDemoUsers(): Promise<void> {
    if (!AuthService.isDemoSeedingEnabled()) {
      securityLogger.info('Demo user seeding disabled');
      return;
    }

    try {
      // Create demo admin user
      const adminExists = AuthService.users.has(
        '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234'
      );
      if (!adminExists) {
        // SECURITY: Demo passwords must also meet strong password policy (Task 102.12)
        await AuthService.signup({
          address: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
          email: 'admin@wrfcoin.com',
          password: 'K9!qLm2#Xv7$Rt5@',
        });

        // Upgrade to admin role
        const adminUser = AuthService.users.get(
          '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234'
        );
        if (adminUser) {
          adminUser.role = 'admin';
        }
      }

      // Create demo regular user
      const userExists = AuthService.users.has(
        '0x123456789abcdef123456789abcdef1234567890'
      );
      if (!userExists) {
        // SECURITY: Demo passwords must also meet strong password policy (Task 102.12)
        await AuthService.signup({
          address: '0x123456789abcdef123456789abcdef1234567890',
          email: 'user@wrfcoin.com',
          password: 'P4!nZr8@Hx2#Cb6$',
        });
      }

      securityLogger.info('Demo users seeded successfully');
    } catch (error) {
      securityLogger.error('Error seeding demo users', { error });
    }
  }

  static isDemoSeedingEnabled(): boolean {
    return (
      process.env.NODE_ENV === 'test' &&
      process.env[AuthService.DEMO_SEED_FLAG] === 'true'
    );
  }

  /**
   * Get all users (admin only)
   */
  static async getAllUsers(): Promise<Omit<User, 'passwordHash'>[]> {
    return Array.from(AuthService.users.values()).map(user => ({
      id: user.id,
      address: user.address,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    }));
  }

  /**
   * Update user role (admin only)
   */
  static async updateUserRole(address: string, newRole: string): Promise<void> {
    const user = AuthService.users.get(address);
    if (!user) {
      throw new Error('User not found');
    }

    if (!['user', 'admin', 'moderator'].includes(newRole)) {
      throw new Error('Invalid role');
    }

    user.role = newRole;
  }
}
