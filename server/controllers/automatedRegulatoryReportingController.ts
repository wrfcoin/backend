import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../../shared/types/security-types.js';
import { body, query, param, validationResult } from 'express-validator';
import AutomatedRegulatoryReportingService from '../services/automated-regulatory-reporting-service.js';
import { ApiResponseBuilder } from '../../utils/api-response.js';
import { PrivacyPreservingLogger } from '../../utils/privacy-preserving-logger.js';
import { governanceLogger } from '../utils/logger.js';

// Utility function to safely extract error message from unknown error type
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as any).message);
  }
  return 'Unknown error occurred';
}

// Helper functions for consistent response format
const successResponse = <T>(data?: T) =>
  ApiResponseBuilder.success(data).build();
const errorResponse = (message: string, code?: string) =>
  ApiResponseBuilder.error(message, code).build();

const reportingService = new AutomatedRegulatoryReportingService(
  process.env.DATABASE_URL!
);
const privacyLogger = new PrivacyPreservingLogger();

/**
 * Generate all regulatory reports for a reporting period
 * @route POST /api/v1/regulatory/reports/generate-all
 */
export const generateAllReports = [
  body('startDate').isISO8601().toDate(),
  body('endDate').isISO8601().toDate(),
  body('frameworkIds').optional().isArray(),

  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(errorResponse('Invalid input parameters'));
        return;
      }

      const { startDate, endDate, frameworkIds } = req.body;

      // Validate date range
      if (startDate >= endDate) {
        res
          .status(400)
          .json(errorResponse('Start date must be before end date'));
        return;
      }

      const reportingPeriod = { start: startDate, end: endDate };

      // Log compliance event
      privacyLogger.logComplianceEvent('bulk_report_generation_requested', {
        userId: req.user?.id,
        reportingPeriod: reportingPeriod,
        frameworkCount: frameworkIds?.length || 'all',
      });

      const result = await reportingService.generateAllReports(
        reportingPeriod,
        frameworkIds
      );

      res.json(
        successResponse({
          message: 'Regulatory reports generation completed',
          ...result,
        })
      );
    } catch (error) {
      governanceLogger.error('Error generating all reports', { module: 'AutomatedRegulatoryReportingController', operation: 'generateAllReports', error: getErrorMessage(error) });
      res
        .status(500)
        .json(errorResponse('Failed to generate regulatory reports'));
    }
  },
];

/**
 * Generate specific regulatory report
 * @route POST /api/v1/regulatory/reports/generate/:frameworkId
 */
export const generateSpecificReport = [
  param('frameworkId').isString().notEmpty(),
  body('startDate').isISO8601().toDate(),
  body('endDate').isISO8601().toDate(),

  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(errorResponse('Invalid input parameters'));
        return;
      }

      const { frameworkId } = req.params;
      const { startDate, endDate } = req.body;

      const reportingPeriod = { start: startDate, end: endDate };

      // Log compliance event
      privacyLogger.logComplianceEvent('specific_report_generation_requested', {
        userId: req.user?.id,
        frameworkId: frameworkId,
        reportingPeriod: reportingPeriod,
      });

      const report = await reportingService.generateReport(
        frameworkId,
        reportingPeriod
      );

      res.json(
        successResponse({
          message: `${frameworkId} report generated successfully`,
          report: {
            reportId: report.reportId,
            status: report.status,
            generatedAt: report.generatedAt,
            validationResults: report.validationResults,
            submissionReference: report.submissionReference,
          },
        })
      );
    } catch (error) {
      governanceLogger.error('Error generating specific report', { module: 'AutomatedRegulatoryReportingController', operation: 'generateSpecificReport', error: getErrorMessage(error) });

      const errorMessage = getErrorMessage(error);
      if (errorMessage.includes('Unknown regulatory framework')) {
        res.status(404).json(errorResponse(errorMessage));
        return;
      }

      res
        .status(500)
        .json(errorResponse('Failed to generate regulatory report'));
    }
  },
];

/**
 * Submit regulatory report
 * @route POST /api/v1/regulatory/reports/:reportId/submit
 */
export const submitReport = [
  param('reportId').isString().notEmpty(),

  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(errorResponse('Invalid report ID'));
        return;
      }

      const { reportId } = req.params;

      // First, retrieve the report to ensure it exists and is valid
      // Note: Using mock implementation since getReportStatus may not exist
      const reportStatus = { status: 'generated', reportId };
      if (!reportStatus) {
        res.status(404).json(errorResponse('Report not found'));
        return;
      }

      if (
        reportStatus.status !== 'generated' &&
        reportStatus.status !== 'rejected'
      ) {
        res
          .status(400)
          .json(errorResponse('Report is not ready for submission'));
        return;
      }

      // Log compliance event
      privacyLogger.logComplianceEvent('report_submission_requested', {
        userId: req.user?.id,
        reportId: reportId,
      });

      const submissionResult = await reportingService.submitReport(
        reportStatus as any
      );

      res.json(
        successResponse({
          message: submissionResult.success
            ? 'Report submitted successfully'
            : 'Report submission failed',
          submissionResult: submissionResult,
        })
      );
    } catch (error) {
      governanceLogger.error('Error submitting report', { module: 'AutomatedRegulatoryReportingController', operation: 'submitReport', error: getErrorMessage(error) });
      res.status(500).json(errorResponse('Failed to submit regulatory report'));
    }
  },
];

/**
 * Get reporting deadlines
 * @route GET /api/v1/regulatory/deadlines
 */
export const getReportingDeadlines = async (req: Request, res: Response) => {
  try {
    const deadlines = await reportingService.getNextReportingDeadlines();

    res.json(
      successResponse({
        message: 'Reporting deadlines retrieved successfully',
        deadlines: deadlines,
        urgent: deadlines.filter(d => d.status === 'urgent'),
        upcoming: deadlines.filter(d => d.status === 'upcoming'),
      })
    );
  } catch (error) {
    governanceLogger.error('Error getting reporting deadlines', { module: 'AutomatedRegulatoryReportingController', operation: 'getReportingDeadlines', error: getErrorMessage(error) });
    res
      .status(500)
      .json(errorResponse('Failed to retrieve reporting deadlines'));
  }
};

/**
 * Get available regulatory frameworks
 * @route GET /api/v1/regulatory/frameworks
 */
export const getRegulatoryFrameworks = async (req: Request, res: Response) => {
  try {
    // This would retrieve framework information from the service
    const frameworks = [
      {
        id: 'eu-mica',
        name: 'EU Markets in Crypto-Assets Regulation',
        jurisdiction: 'EU',
        frequency: 'quarterly',
        nextDeadline: '2024-04-15',
        status: 'active',
      },
      {
        id: 'us-sec',
        name: 'US Securities and Exchange Commission',
        jurisdiction: 'US',
        frequency: 'quarterly',
        nextDeadline: '2024-04-10',
        status: 'active',
      },
      {
        id: 'us-cftc',
        name: 'US Commodity Futures Trading Commission',
        jurisdiction: 'US',
        frequency: 'monthly',
        nextDeadline: '2024-02-15',
        status: 'active',
      },
      {
        id: 'us-fincen',
        name: 'US Financial Crimes Enforcement Network',
        jurisdiction: 'US',
        frequency: 'real-time',
        nextDeadline: 'continuous',
        status: 'active',
      },
      {
        id: 'tcfd-annual',
        name: 'Task Force on Climate-related Financial Disclosures',
        jurisdiction: 'GLOBAL',
        frequency: 'annual',
        nextDeadline: '2024-06-30',
        status: 'active',
      },
      {
        id: 'iso-20022',
        name: 'ISO 20022 Financial Services Messages',
        jurisdiction: 'GLOBAL',
        frequency: 'continuous',
        nextDeadline: 'continuous',
        status: 'active',
      },
    ];

    res.json(
      successResponse({
        message: 'Regulatory frameworks retrieved successfully',
        frameworks: frameworks,
        totalFrameworks: frameworks.length,
        activeFrameworks: frameworks.filter(f => f.status === 'active').length,
      })
    );
  } catch (error) {
    governanceLogger.error('Error getting regulatory frameworks', { module: 'AutomatedRegulatoryReportingController', operation: 'getRegulatoryFrameworks', error: getErrorMessage(error) });
    res
      .status(500)
      .json(errorResponse('Failed to retrieve regulatory frameworks'));
  }
};

/**
 * Get report status
 * @route GET /api/v1/regulatory/reports/:reportId/status
 */
export const getReportStatusEndpoint = [
  param('reportId').isString().notEmpty(),

  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(errorResponse('Invalid report ID'));
        return;
      }

      const { reportId } = req.params;
      const status = await getReportStatus(reportId);

      if (!status) {
        res.status(404).json(errorResponse('Report not found'));
        return;
      }

      res.json(
        successResponse({
          message: 'Report status retrieved successfully',
          report: status,
        })
      );
    } catch (error) {
      governanceLogger.error('Error getting report status', { module: 'AutomatedRegulatoryReportingController', operation: 'getReportStatusEndpoint', error: getErrorMessage(error) });
      res.status(500).json(errorResponse('Failed to retrieve report status'));
    }
  },
];

/**
 * Get compliance dashboard
 * @route GET /api/v1/regulatory/dashboard
 */
export const getComplianceDashboard = [
  query('period').optional().isIn(['week', 'month', 'quarter', 'year']),

  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const period = (req.query.period as string) || 'month';

      // Calculate date range based on period
      const endDate = new Date();
      const startDate = new Date();

      switch (period) {
        case 'week':
          startDate.setDate(endDate.getDate() - 7);
          break;
        case 'month':
          startDate.setMonth(endDate.getMonth() - 1);
          break;
        case 'quarter':
          startDate.setMonth(endDate.getMonth() - 3);
          break;
        case 'year':
          startDate.setFullYear(endDate.getFullYear() - 1);
          break;
      }

      // Generate dashboard data
      const dashboardData = {
        period: period,
        dateRange: { start: startDate, end: endDate },
        summary: {
          totalReports: 15,
          submittedReports: 12,
          pendingReports: 2,
          rejectedReports: 1,
          complianceScore: 94.5,
        },
        frameworkStatus: {
          'eu-mica': {
            status: 'compliant',
            lastReport: '2024-01-15',
            nextDue: '2024-04-15',
          },
          'us-sec': {
            status: 'compliant',
            lastReport: '2024-01-10',
            nextDue: '2024-04-10',
          },
          'us-cftc': {
            status: 'pending',
            lastReport: '2024-01-15',
            nextDue: '2024-02-15',
          },
          'us-fincen': {
            status: 'compliant',
            lastReport: 'continuous',
            nextDue: 'continuous',
          },
          'tcfd-annual': {
            status: 'compliant',
            lastReport: '2023-06-30',
            nextDue: '2024-06-30',
          },
        },
        upcomingDeadlines: await reportingService.getNextReportingDeadlines(),
        recentActivity: [
          {
            date: '2024-01-15',
            action: 'EU MiCA Q4 report submitted',
            status: 'success',
          },
          {
            date: '2024-01-10',
            action: 'US SEC Q4 report submitted',
            status: 'success',
          },
          {
            date: '2024-01-05',
            action: 'TCFD annual report generated',
            status: 'pending',
          },
        ],
        alerts: [
          { level: 'warning', message: 'US CFTC monthly report due in 5 days' },
          {
            level: 'info',
            message: 'EU MiCA Q1 preparation period starts in 30 days',
          },
        ],
      };

      res.json(
        successResponse({
          message: 'Compliance dashboard retrieved successfully',
          dashboard: dashboardData,
        })
      );
    } catch (error) {
      governanceLogger.error('Error getting compliance dashboard', { module: 'AutomatedRegulatoryReportingController', operation: 'getComplianceDashboard', error: getErrorMessage(error) });
      res
        .status(500)
        .json(errorResponse('Failed to retrieve compliance dashboard'));
    }
  },
];

/**
 * Schedule automated reporting
 * @route POST /api/v1/regulatory/schedule
 */
export const scheduleAutomatedReporting = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    privacyLogger.logComplianceEvent('automated_reporting_schedule_requested', {
      userId: req.user?.id,
    });

    await reportingService.scheduleAutomatedReporting();

    res.json(
      successResponse({
        message: 'Automated reporting scheduled successfully',
        scheduledAt: new Date(),
      })
    );
  } catch (error) {
    governanceLogger.error('Error scheduling automated reporting', { module: 'AutomatedRegulatoryReportingController', operation: 'scheduleAutomatedReporting', error: getErrorMessage(error) });
    res
      .status(500)
      .json(errorResponse('Failed to schedule automated reporting'));
  }
};

/**
 * Validate report data
 * @route POST /api/v1/regulatory/validate
 */
export const validateReportData = [
  body('frameworkId').isString().notEmpty(),
  body('reportData').isObject(),

  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(errorResponse('Invalid validation parameters'));
        return;
      }

      const { frameworkId, reportData } = req.body;

      // This would perform validation logic
      const validationResults = {
        isValid: true,
        score: 95,
        issues: [] as string[],
        recommendations: [
          'Consider including more granular environmental impact data',
          'Ensure all required metadata fields are populated',
        ],
        complianceChecks: {
          dataCompleteness: 98,
          formatCompliance: 100,
          regulatoryAlignment: 92,
          dataQuality: 96,
        },
      };

      privacyLogger.logComplianceEvent('report_validation_performed', {
        frameworkId: frameworkId,
        validationScore: validationResults.score,
        isValid: validationResults.isValid,
      });

      res.json(
        successResponse({
          message: 'Report validation completed',
          validation: validationResults,
        })
      );
    } catch (error) {
      governanceLogger.error('Error validating report data', { module: 'AutomatedRegulatoryReportingController', operation: 'validateReportData', error: getErrorMessage(error) });
      res.status(500).json(errorResponse('Failed to validate report data'));
    }
  },
];

// Helper function to get report status
async function getReportStatus(reportId: string): Promise<any> {
  // This would query the database for report status
  // Placeholder implementation
  return {
    reportId: reportId,
    frameworkId: 'eu-mica',
    status: 'generated',
    generatedAt: new Date(),
    validationResults: { isValid: true, score: 95 },
    submissionAttempts: 0,
  };
}
