import { describe, it, expect, beforeEach } from '@jest/globals';
const request = require('supertest');
const express = require('express');
import { authRoutes } from '../routes/auth-routes.js';
import { AuthService } from '../services/auth-service.js';

describe('Authentication System', () => {
  let app: any;

  beforeEach(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);

    // Clear users before each test
    (AuthService as any).users = new Map();
  });

  describe('POST /api/auth/signup', () => {
    it('should create a new user', async () => {
      const userData = {
        address: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        email: 'test@example.com',
        password: 'password123',
      };

      const response = await request(app)
        .post('/api/auth/signup')
        .send(userData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('user');
      expect(response.body.data).toHaveProperty('token');
      expect(response.body.data.user.address).toBe(userData.address);
      expect(response.body.data.user.role).toBe('user');
    });

    it('should reject invalid wallet address', async () => {
      const userData = {
        address: 'invalid-address',
        password: 'password123',
      };

      const response = await request(app)
        .post('/api/auth/signup')
        .send(userData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('INVALID_ADDRESS');
    });

    it('should reject weak password', async () => {
      const userData = {
        address: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        password: '123',
      };

      const response = await request(app)
        .post('/api/auth/signup')
        .send(userData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('WEAK_PASSWORD');
    });

    it('should reject duplicate user', async () => {
      const userData = {
        address: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        password: 'password123',
      };

      // Create user first time
      await request(app).post('/api/auth/signup').send(userData).expect(201);

      // Try to create same user again
      const response = await request(app)
        .post('/api/auth/signup')
        .send(userData)
        .expect(409);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('USER_EXISTS');
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      // Create a test user
      await request(app).post('/api/auth/signup').send({
        address: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        password: 'password123',
      });
    });

    it('should authenticate valid credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          address: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
          password: 'password123',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('user');
      expect(response.body.data).toHaveProperty('token');
      expect(typeof response.body.data.token).toBe('string');
    });

    it('should reject invalid credentials', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          address: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
          password: 'wrong-password',
        })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('LOGIN_FAILED');
    });

    it('should reject non-existent user', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          address: '0x123456789abcdef123456789abcdef1234567890',
          password: 'password123',
        })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('LOGIN_FAILED');
    });
  });

  describe('GET /api/auth/me', () => {
    let authToken: string;

    beforeEach(async () => {
      // Create and login user
      const signupResponse = await request(app).post('/api/auth/signup').send({
        address: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        email: 'test@example.com',
        password: 'password123',
      });

      authToken = signupResponse.body.data.token;
    });

    it('should return user info with valid token', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('id');
      expect(response.body.data).toHaveProperty('address');
      expect(response.body.data).toHaveProperty('role');
      expect(response.body.data.address).toBe(
        '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234'
      );
    });

    it('should reject request without token', async () => {
      const response = await request(app).get('/api/auth/me').expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MISSING_TOKEN');
    });

    it('should reject invalid token', async () => {
      const response = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid-token')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('INVALID_TOKEN');
    });
  });
});
