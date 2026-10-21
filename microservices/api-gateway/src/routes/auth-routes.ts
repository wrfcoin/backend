import { Router } from 'express';
import { AuthService } from '../services/auth-service.js';
import {
  AuthMiddleware,
  AuthenticatedRequest,
} from '../middleware/auth-middleware.js';
import { Response } from 'express';

const router = Router();

// POST /api/auth/signup - Register new user
router.post('/signup', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { address, email, password } = req.body;

    if (!address || !password) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_FIELDS',
          message: 'Address and password are required',
        },
        timestamp: new Date().toISOString(),
      });
    }

    const authResponse = await AuthService.signup({ address, email, password });

    return res.status(201).json({
      success: true,
      data: authResponse,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Signup error:', error);

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    // Handle specific error types
    let statusCode = 500;
    let errorCode = 'SIGNUP_ERROR';

    if (errorMessage.includes('already exists')) {
      statusCode = 409;
      errorCode = 'USER_EXISTS';
    } else if (errorMessage.includes('Invalid wallet address')) {
      statusCode = 400;
      errorCode = 'INVALID_ADDRESS';
    } else if (errorMessage.includes('Password must be')) {
      statusCode = 400;
      errorCode = 'WEAK_PASSWORD';
    }

    return res.status(statusCode).json({
      success: false,
      error: {
        code: errorCode,
        message: errorMessage,
      },
      timestamp: new Date().toISOString(),
    });
  }
});

// POST /api/auth/login - Authenticate user
router.post('/login', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { address, password } = req.body;

    if (!address || !password) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_CREDENTIALS',
          message: 'Address and password are required',
        },
        timestamp: new Date().toISOString(),
      });
    }

    const authResponse = await AuthService.login({ address, password });

    return res.json({
      success: true,
      data: authResponse,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Login error:', error);

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    return res.status(401).json({
      success: false,
      error: {
        code: 'LOGIN_FAILED',
        message: errorMessage,
      },
      timestamp: new Date().toISOString(),
    });
  }
});

// GET /api/auth/me - Get current user info
router.get(
  '/me',
  AuthMiddleware.verifyUserToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User information not available',
          },
          timestamp: new Date().toISOString(),
        });
      }

      const user = await AuthService.getUserByAddress(req.user.address);

      if (!user) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'USER_NOT_FOUND',
            message: 'User not found',
          },
          timestamp: new Date().toISOString(),
        });
      }

      return res.json({
        success: true,
        data: {
          id: user.id,
          address: user.address,
          email: user.email,
          role: user.role,
          createdAt: user.createdAt,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Get user error:', error);
      return res.status(500).json({
        success: false,
        error: {
          code: 'USER_FETCH_ERROR',
          message: 'Failed to fetch user information',
        },
        timestamp: new Date().toISOString(),
      });
    }
  }
);

// GET /api/auth/users - Get all users (admin only)
router.get(
  '/users',
  AuthMiddleware.verifyUserToken,
  AuthMiddleware.requireRole('admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const users = await AuthService.getAllUsers();

      res.json({
        success: true,
        data: {
          users,
          count: users.length,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Get users error:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'USERS_FETCH_ERROR',
          message: 'Failed to fetch users',
        },
        timestamp: new Date().toISOString(),
      });
    }
  }
);

// PUT /api/auth/users/:address/role - Update user role (admin only)
router.put(
  '/users/:address/role',
  AuthMiddleware.verifyUserToken,
  AuthMiddleware.requireRole('admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { address } = req.params;
      const { role } = req.body;

      if (!role) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_ROLE',
            message: 'Role is required',
          },
          timestamp: new Date().toISOString(),
        });
      }

      await AuthService.updateUserRole(address, role);

      return res.json({
        success: true,
        data: {
          message: 'User role updated successfully',
          address,
          role,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Update role error:', error);

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      let statusCode = 500;

      if (errorMessage.includes('not found')) {
        statusCode = 404;
      } else if (errorMessage.includes('Invalid role')) {
        statusCode = 400;
      }

      return res.status(statusCode).json({
        success: false,
        error: {
          code: 'ROLE_UPDATE_ERROR',
          message: errorMessage,
        },
        timestamp: new Date().toISOString(),
      });
    }
  }
);

export { router as authRoutes };
