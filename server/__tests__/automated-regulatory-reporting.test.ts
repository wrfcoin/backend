const request = require('supertest');
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
const express = require('express');
import AutomatedRegulatoryReportingService from '../services/automated-regulatory-reporting-service.js';
import regulatoryReportingRoutes from '../routes/automated-regulatory-reporting-routes.js';
import { authenticateJWT } from '../middleware/auth.js';

// Mock dependencies
jest.mock('../services/automated-regulatory-reporting-service.js');
jest.mock('../middleware/auth.js');
jest.mock('../middleware/rbac.js');
jest.mock('../middleware/apiAudit.js');
jest.mock('../middleware/rateLimiting.js');

const app = express();
app.use(express.json());

// Mock authentication middleware
(
  authenticateJWT as jest.MockedFunction<typeof authenticateJWT>
).mockImplementation(async (req: any, res: any, next: any) => {
  req.user = { id: 'test-user', role: 'compliance_officer' };
  next();
});

// Mock RBAC middleware
jest.mock('../middleware/rbac.js', () => ({
  requireRole: () => (req: any, res: any, next: any) => next(),
}));

// Mock audit middleware
jest.mock('../middleware/apiAudit.js', () => ({
  auditMiddleware: (req: any, res: any, next: any) => next(),
}));

// Mock rate limiting middleware
jest.mock('../middleware/rateLimiting.js', () => ({
  rateLimiter: () => (req: any, res: any, next: any) => next(),
}));

app.use('/api/v1/regulatory', regulatoryReportingRoutes);

describe('Automated Regulatory Reporting API', () => {
  let mockReportingService: jest.Mocked<AutomatedRegulatoryReportingService>;

  beforeEach(() => {
    mockReportingService = jest.mocked(
      new AutomatedRegulatoryReportingService('test://db')
    );
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /api/v1/regulatory/reports/generate-all', () => {
    it('should generate all regulatory reports successfully', async () => {
      const mockReportingPeriod = {
        start: new Date('2024-01-01'),
        end: new Date('2024-03-31'),
      };

      const mockResults = {
        successful: [
          {
            reportId: 'REG-EU-MICA-2024-01-01_2024-03-31-1705123456789',
            frameworkId: 'eu-mica',
            reportingPeriod: mockReportingPeriod,
            generatedAt: new Date(),
            status: 'generated' as const,
            reportData: { summary: 'test data' },
            validationResults: { isValid: true, score: 95 },
            submissionAttempts: 0,
          },
        ],
        failed: [],
        summary: {
          totalFrameworks: 1,
          successful: 1,
          failed: 0,
          generationTime: new Date(),
          nextDueDates: [],
        },
      };

      mockReportingService.generateAllReports.mockResolvedValue(mockResults);

      const response = await request(app)
        .post('/api/v1/regulatory/reports/generate-all')
        .send({
          startDate: '2024-01-01T00:00:00Z',
          endDate: '2024-03-31T23:59:59Z',
          frameworkIds: ['eu-mica'],
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.successful).toHaveLength(1);
      expect(response.body.data.failed).toHaveLength(0);
      expect(response.body.data.summary.totalFrameworks).toBe(1);
    });

    it('should return 400 for invalid date range', async () => {
      const response = await request(app)
        .post('/api/v1/regulatory/reports/generate-all')
        .send({
          startDate: '2024-03-31T00:00:00Z',
          endDate: '2024-01-01T23:59:59Z', // End date before start date
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain(
        'Start date must be before end date'
      );
    });

    it('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/regulatory/reports/generate-all')
        .send({
          startDate: '2024-01-01T00:00:00Z',
          // Missing endDate
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/v1/regulatory/reports/generate/:frameworkId', () => {
    it('should generate specific regulatory report successfully', async () => {
      const mockReport = {
        reportId: 'REG-EU-MICA-2024-01-01_2024-03-31-1705123456789',
        frameworkId: 'eu-mica',
        reportingPeriod: {
          start: new Date('2024-01-01'),
          end: new Date('2024-03-31'),
        },
        generatedAt: new Date(),
        status: 'generated' as const,
        reportData: { summary: 'test data' },
        validationResults: { isValid: true, score: 95 },
        submissionAttempts: 0,
      };

      mockReportingService.generateReport.mockResolvedValue(mockReport);

      const response = await request(app)
        .post('/api/v1/regulatory/reports/generate/eu-mica')
        .send({
          startDate: '2024-01-01T00:00:00Z',
          endDate: '2024-03-31T23:59:59Z',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.report.reportId).toBe(mockReport.reportId);
      expect(response.body.data.report.status).toBe('generated');
    });

    it('should return 404 for unknown framework', async () => {
      mockReportingService.generateReport.mockRejectedValue(
        new Error('Unknown regulatory framework: unknown-framework')
      );

      const response = await request(app)
        .post('/api/v1/regulatory/reports/generate/unknown-framework')
        .send({
          startDate: '2024-01-01T00:00:00Z',
          endDate: '2024-03-31T23:59:59Z',
        })
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Unknown regulatory framework');
    });
  });

  describe('POST /api/v1/regulatory/reports/:reportId/submit', () => {
    it('should submit report successfully', async () => {
      const mockSubmissionResult = {
        success: true,
        submissionReference: 'SUB-1705123456789',
      };

      mockReportingService.submitReport.mockResolvedValue(mockSubmissionResult);

      const response = await request(app)
        .post('/api/v1/regulatory/reports/REG-EU-MICA-123/submit')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.submissionResult.success).toBe(true);
      expect(response.body.data.submissionResult.submissionReference).toBe(
        'SUB-1705123456789'
      );
    });

    it('should handle submission failure', async () => {
      const mockSubmissionResult = {
        success: false,
        error: 'API endpoint unavailable',
      };

      mockReportingService.submitReport.mockResolvedValue(mockSubmissionResult);

      const response = await request(app)
        .post('/api/v1/regulatory/reports/REG-EU-MICA-123/submit')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.submissionResult.success).toBe(false);
      expect(response.body.data.submissionResult.error).toBe(
        'API endpoint unavailable'
      );
    });
  });

  describe('GET /api/v1/regulatory/deadlines', () => {
    it('should return upcoming reporting deadlines', async () => {
      const mockDeadlines = [
        {
          frameworkId: 'eu-mica',
          deadline: new Date('2024-04-15'),
          status: 'upcoming',
          daysRemaining: 30,
        },
        {
          frameworkId: 'us-sec',
          deadline: new Date('2024-04-10'),
          status: 'urgent',
          daysRemaining: 5,
        },
      ];

      mockReportingService.getNextReportingDeadlines.mockResolvedValue(
        mockDeadlines
      );

      const response = await request(app)
        .get('/api/v1/regulatory/deadlines')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.deadlines).toHaveLength(2);
      expect(response.body.data.urgent).toHaveLength(1);
      expect(response.body.data.upcoming).toHaveLength(1);
    });
  });

  describe('GET /api/v1/regulatory/frameworks', () => {
    it('should return available regulatory frameworks', async () => {
      const response = await request(app)
        .get('/api/v1/regulatory/frameworks')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.frameworks).toBeDefined();
      expect(response.body.data.totalFrameworks).toBeGreaterThan(0);
      expect(response.body.data.activeFrameworks).toBeGreaterThan(0);

      // Check that EU MiCA framework is included
      const euMicaFramework = response.body.data.frameworks.find(
        (f: any) => f.id === 'eu-mica'
      );
      expect(euMicaFramework).toBeDefined();
      expect(euMicaFramework.name).toBe(
        'EU Markets in Crypto-Assets Regulation'
      );
      expect(euMicaFramework.jurisdiction).toBe('EU');
    });
  });

  describe('GET /api/v1/regulatory/reports/:reportId/status', () => {
    it('should return report status', async () => {
      const response = await request(app)
        .get('/api/v1/regulatory/reports/REG-EU-MICA-123/status')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.report).toBeDefined();
      expect(response.body.data.report.reportId).toBe('REG-EU-MICA-123');
    });

    it('should return 400 for invalid report ID', async () => {
      const response = await request(app)
        .get('/api/v1/regulatory/reports/ /status') // Invalid ID with space
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/v1/regulatory/dashboard', () => {
    it('should return compliance dashboard with default period', async () => {
      mockReportingService.getNextReportingDeadlines.mockResolvedValue([]);

      const response = await request(app)
        .get('/api/v1/regulatory/dashboard')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.dashboard).toBeDefined();
      expect(response.body.data.dashboard.period).toBe('month');
      expect(response.body.data.dashboard.summary).toBeDefined();
      expect(response.body.data.dashboard.frameworkStatus).toBeDefined();
    });

    it('should return dashboard for specific period', async () => {
      mockReportingService.getNextReportingDeadlines.mockResolvedValue([]);

      const response = await request(app)
        .get('/api/v1/regulatory/dashboard?period=quarter')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.dashboard.period).toBe('quarter');
    });
  });

  describe('POST /api/v1/regulatory/schedule', () => {
    it('should schedule automated reporting successfully', async () => {
      mockReportingService.scheduleAutomatedReporting.mockResolvedValue(
        undefined
      );

      const response = await request(app)
        .post('/api/v1/regulatory/schedule')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.message).toContain('scheduled successfully');
      expect(response.body.data.scheduledAt).toBeDefined();
    });
  });

  describe('POST /api/v1/regulatory/validate', () => {
    it('should validate report data successfully', async () => {
      const response = await request(app)
        .post('/api/v1/regulatory/validate')
        .send({
          frameworkId: 'eu-mica',
          reportData: {
            environmentalImpact: { carbonFootprint: 1000 },
            transactionVolumes: { total: 50000 },
          },
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.validation).toBeDefined();
      expect(response.body.data.validation.isValid).toBe(true);
      expect(response.body.data.validation.score).toBeGreaterThan(0);
    });

    it('should return 400 for missing required fields', async () => {
      const response = await request(app)
        .post('/api/v1/regulatory/validate')
        .send({
          frameworkId: 'eu-mica',
          // Missing reportData
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('Integration Tests', () => {
    it('should handle full report generation and submission workflow', async () => {
      // Mock the full workflow
      const mockReport = {
        reportId: 'REG-EU-MICA-2024-01-01_2024-03-31-1705123456789',
        frameworkId: 'eu-mica',
        reportingPeriod: {
          start: new Date('2024-01-01'),
          end: new Date('2024-03-31'),
        },
        generatedAt: new Date(),
        status: 'generated' as const,
        reportData: { summary: 'test data' },
        validationResults: { isValid: true, score: 95 },
        submissionAttempts: 0,
      };

      const mockSubmissionResult = {
        success: true,
        submissionReference: 'SUB-1705123456789',
      };

      mockReportingService.generateReport.mockResolvedValue(mockReport);
      mockReportingService.submitReport.mockResolvedValue(mockSubmissionResult);

      // 1. Generate report
      const generateResponse = await request(app)
        .post('/api/v1/regulatory/reports/generate/eu-mica')
        .send({
          startDate: '2024-01-01T00:00:00Z',
          endDate: '2024-03-31T23:59:59Z',
        })
        .expect(200);

      expect(generateResponse.body.success).toBe(true);
      const reportId = generateResponse.body.data.report.reportId;

      // 2. Submit report
      const submitResponse = await request(app)
        .post(`/api/v1/regulatory/reports/${reportId}/submit`)
        .expect(200);

      expect(submitResponse.body.success).toBe(true);
      expect(submitResponse.body.data.submissionResult.success).toBe(true);
    });

    it('should handle validation errors in report generation', async () => {
      mockReportingService.generateReport.mockRejectedValue(
        new Error('Validation failed: Missing required data fields')
      );

      const response = await request(app)
        .post('/api/v1/regulatory/reports/generate/eu-mica')
        .send({
          startDate: '2024-01-01T00:00:00Z',
          endDate: '2024-03-31T23:59:59Z',
        })
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain(
        'Failed to generate regulatory report'
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle service unavailable errors gracefully', async () => {
      mockReportingService.generateReport.mockRejectedValue(
        new Error('Database connection failed')
      );

      const response = await request(app)
        .post('/api/v1/regulatory/reports/generate/eu-mica')
        .send({
          startDate: '2024-01-01T00:00:00Z',
          endDate: '2024-03-31T23:59:59Z',
        })
        .expect(500);

      expect(response.body.success).toBe(false);
    });

    it('should validate date formats properly', async () => {
      const response = await request(app)
        .post('/api/v1/regulatory/reports/generate/eu-mica')
        .send({
          startDate: 'invalid-date',
          endDate: '2024-03-31T23:59:59Z',
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });
});

describe('AutomatedRegulatoryReportingService Unit Tests', () => {
  let service: AutomatedRegulatoryReportingService;

  beforeEach(() => {
    service = new AutomatedRegulatoryReportingService('test://database');
  });

  describe('generateReport', () => {
    it('should throw error for unknown framework', async () => {
      const reportingPeriod = {
        start: new Date('2024-01-01'),
        end: new Date('2024-03-31'),
      };

      await expect(
        service.generateReport('unknown-framework', reportingPeriod)
      ).rejects.toThrow('Unknown regulatory framework: unknown-framework');
    });
  });

  describe('Data Extraction and Transformation', () => {
    it('should validate data extraction rules', () => {
      // Test that data extraction rules are properly configured
      expect(service).toBeDefined();
      // Additional unit tests would test individual methods
    });
  });

  describe('Compliance Validation', () => {
    it('should validate framework-specific requirements', () => {
      // Test framework-specific validation logic
      expect(service).toBeDefined();
    });
  });
});
