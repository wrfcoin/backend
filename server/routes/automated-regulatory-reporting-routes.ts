import express, { Request, Response, NextFunction, Router } from 'express';
import { AuthenticatedRequest } from '../../shared/types/security-types.js';
import {
  generateAllReports,
  generateSpecificReport,
  submitReport,
  getReportingDeadlines,
  getRegulatoryFrameworks,
  getReportStatusEndpoint as getReportStatus,
  getComplianceDashboard,
  scheduleAutomatedReporting,
  validateReportData,
} from '../controllers/automatedRegulatoryReportingController.js';
import { authenticateJWT, requireRole } from '../middleware/auth.js';
import apiAudit from '../middleware/apiAudit.js';
import { generalLimiter as rateLimiter } from '../../middleware/rateLimiting.js';

const router: Router = express.Router();

/**
 * @swagger
 * /api/v1/regulatory/reports/generate-all:
 *   post:
 *     summary: Generate all regulatory reports for a reporting period
 *     description: |
 *       Generates all required regulatory reports for the specified time period.
 *       This endpoint creates reports for multiple regulatory frameworks simultaneously.
 *     tags: [Regulatory Reporting]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - startDate
 *               - endDate
 *             properties:
 *               startDate:
 *                 type: string
 *                 format: date-time
 *                 description: Start date of reporting period
 *                 example: "2024-01-01T00:00:00Z"
 *               endDate:
 *                 type: string
 *                 format: date-time
 *                 description: End date of reporting period
 *                 example: "2024-03-31T23:59:59Z"
 *               frameworkIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Optional list of specific frameworks to generate reports for
 *                 example: ["eu-mica", "us-sec", "tcfd-annual"]
 *     responses:
 *       200:
 *         description: Reports generation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     successful:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/RegulatoryReport'
 *                     failed:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           frameworkId:
 *                             type: string
 *                           error:
 *                             type: string
 *                     summary:
 *                       type: object
 *                       properties:
 *                         totalFrameworks:
 *                           type: integer
 *                         successful:
 *                           type: integer
 *                         failed:
 *                           type: integer
 *                         generationTime:
 *                           type: string
 *                           format: date-time
 *       400:
 *         description: Invalid input parameters
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Insufficient permissions
 *       500:
 *         description: Internal server error
 */
router.post(
  '/reports/generate-all',
  authenticateJWT as any,
  requireRole(['admin', 'compliance_officer']) as any,
  apiAudit as any,
  rateLimiter({ windowMs: 60000, max: 5 }) as any, // 5 requests per minute
  generateAllReports as any
);

/**
 * @swagger
 * /api/v1/regulatory/reports/generate/{frameworkId}:
 *   post:
 *     summary: Generate specific regulatory report
 *     description: Generate a regulatory report for a specific framework and reporting period
 *     tags: [Regulatory Reporting]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: frameworkId
 *         required: true
 *         schema:
 *           type: string
 *           enum: [eu-mica, us-sec, us-cftc, us-fincen, tcfd-annual, iso-20022]
 *         description: Regulatory framework identifier
 *         example: "eu-mica"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - startDate
 *               - endDate
 *             properties:
 *               startDate:
 *                 type: string
 *                 format: date-time
 *               endDate:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Report generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                     report:
 *                       $ref: '#/components/schemas/RegulatoryReportSummary'
 *       404:
 *         description: Framework not found
 *       500:
 *         description: Report generation failed
 */
router.post(
  '/reports/generate/:frameworkId',
  authenticateJWT as any,
  requireRole(['admin', 'compliance_officer']) as any,
  apiAudit as any,
  rateLimiter({ windowMs: 60000, max: 10 }) as any,
  generateSpecificReport as any
);

/**
 * @swagger
 * /api/v1/regulatory/reports/{reportId}/submit:
 *   post:
 *     summary: Submit regulatory report
 *     description: Submit a generated regulatory report to the appropriate regulatory authority
 *     tags: [Regulatory Reporting]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: reportId
 *         required: true
 *         schema:
 *           type: string
 *         description: Report identifier
 *         example: "REG-EU-MICA-2024-01-01_2024-03-31-1705123456789"
 *     responses:
 *       200:
 *         description: Report submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                     submissionResult:
 *                       type: object
 *                       properties:
 *                         success:
 *                           type: boolean
 *                         submissionReference:
 *                           type: string
 *                         error:
 *                           type: string
 *       400:
 *         description: Report not ready for submission
 *       404:
 *         description: Report not found
 *       500:
 *         description: Submission failed
 */
router.post(
  '/reports/:reportId/submit',
  authenticateJWT as any,
  requireRole(['admin', 'compliance_officer']) as any,
  apiAudit as any,
  rateLimiter({ windowMs: 60000, max: 20 }) as any,
  submitReport as any
);

/**
 * @swagger
 * /api/v1/regulatory/deadlines:
 *   get:
 *     summary: Get upcoming reporting deadlines
 *     description: Retrieve all upcoming regulatory reporting deadlines with urgency indicators
 *     tags: [Regulatory Reporting]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Deadlines retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     deadlines:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/ReportingDeadline'
 *                     urgent:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/ReportingDeadline'
 *                     upcoming:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/ReportingDeadline'
 *       500:
 *         description: Failed to retrieve deadlines
 */
router.get(
  '/deadlines',
  authenticateJWT as any,
  requireRole(['admin', 'compliance_officer', 'auditor']) as any,
  getReportingDeadlines as any
);

/**
 * @swagger
 * /api/v1/regulatory/frameworks:
 *   get:
 *     summary: Get available regulatory frameworks
 *     description: Retrieve list of all supported regulatory frameworks and their configuration
 *     tags: [Regulatory Reporting]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Frameworks retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     frameworks:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/RegulatoryFramework'
 *                     totalFrameworks:
 *                       type: integer
 *                     activeFrameworks:
 *                       type: integer
 */
router.get(
  '/frameworks',
  authenticateJWT as any,
  requireRole(['admin', 'compliance_officer', 'auditor']) as any,
  getRegulatoryFrameworks as any
);

/**
 * @swagger
 * /api/v1/regulatory/reports/{reportId}/status:
 *   get:
 *     summary: Get report status
 *     description: Retrieve the current status and details of a specific regulatory report
 *     tags: [Regulatory Reporting]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: reportId
 *         required: true
 *         schema:
 *           type: string
 *         description: Report identifier
 *     responses:
 *       200:
 *         description: Report status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     report:
 *                       $ref: '#/components/schemas/RegulatoryReport'
 *       404:
 *         description: Report not found
 */
router.get(
  '/reports/:reportId/status',
  authenticateJWT as any,
  requireRole(['admin', 'compliance_officer', 'auditor']) as any,
  getReportStatus as any
);

/**
 * @swagger
 * /api/v1/regulatory/dashboard:
 *   get:
 *     summary: Get compliance dashboard
 *     description: Retrieve comprehensive compliance dashboard with metrics and status information
 *     tags: [Regulatory Reporting]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [week, month, quarter, year]
 *           default: month
 *         description: Time period for dashboard data
 *     responses:
 *       200:
 *         description: Dashboard data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     dashboard:
 *                       $ref: '#/components/schemas/ComplianceDashboard'
 */
router.get(
  '/dashboard',
  authenticateJWT as any,
  requireRole(['admin', 'compliance_officer', 'auditor']) as any,
  getComplianceDashboard as any
);

/**
 * @swagger
 * /api/v1/regulatory/schedule:
 *   post:
 *     summary: Schedule automated reporting
 *     description: Set up automated generation and submission of regulatory reports based on configured schedules
 *     tags: [Regulatory Reporting]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Automated reporting scheduled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                     scheduledAt:
 *                       type: string
 *                       format: date-time
 *       500:
 *         description: Failed to schedule automated reporting
 */
router.post(
  '/schedule',
  authenticateJWT as any,
  requireRole(['admin']) as any,
  apiAudit as any,
  scheduleAutomatedReporting as any
);

/**
 * @swagger
 * /api/v1/regulatory/validate:
 *   post:
 *     summary: Validate report data
 *     description: Validate regulatory report data against framework requirements before generation
 *     tags: [Regulatory Reporting]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - frameworkId
 *               - reportData
 *             properties:
 *               frameworkId:
 *                 type: string
 *                 description: Regulatory framework identifier
 *               reportData:
 *                 type: object
 *                 description: Report data to validate
 *     responses:
 *       200:
 *         description: Validation completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     validation:
 *                       $ref: '#/components/schemas/ValidationResults'
 *       400:
 *         description: Invalid validation parameters
 */
router.post(
  '/validate',
  authenticateJWT as any,
  requireRole(['admin', 'compliance_officer']) as any,
  rateLimiter({ windowMs: 60000, max: 30 }) as any,
  validateReportData as any
);

/**
 * @swagger
 * components:
 *   schemas:
 *     RegulatoryReport:
 *       type: object
 *       properties:
 *         reportId:
 *           type: string
 *           description: Unique report identifier
 *         frameworkId:
 *           type: string
 *           description: Regulatory framework identifier
 *         reportingPeriod:
 *           type: object
 *           properties:
 *             start:
 *               type: string
 *               format: date-time
 *             end:
 *               type: string
 *               format: date-time
 *         generatedAt:
 *           type: string
 *           format: date-time
 *         status:
 *           type: string
 *           enum: [pending, generated, validated, submitted, rejected, approved]
 *         reportData:
 *           type: object
 *           description: Complete report content
 *         submissionReference:
 *           type: string
 *           description: Reference from regulatory authority
 *         validationResults:
 *           $ref: '#/components/schemas/ValidationResults'
 *         submissionAttempts:
 *           type: integer
 *         nextSubmissionDate:
 *           type: string
 *           format: date-time
 *
 *     RegulatoryReportSummary:
 *       type: object
 *       properties:
 *         reportId:
 *           type: string
 *         status:
 *           type: string
 *         generatedAt:
 *           type: string
 *           format: date-time
 *         validationResults:
 *           $ref: '#/components/schemas/ValidationResults'
 *         submissionReference:
 *           type: string
 *
 *     ReportingDeadline:
 *       type: object
 *       properties:
 *         frameworkId:
 *           type: string
 *         deadline:
 *           type: string
 *           format: date-time
 *         status:
 *           type: string
 *           enum: [urgent, upcoming]
 *         daysRemaining:
 *           type: integer
 *
 *     RegulatoryFramework:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         name:
 *           type: string
 *         jurisdiction:
 *           type: string
 *         frequency:
 *           type: string
 *         nextDeadline:
 *           type: string
 *         status:
 *           type: string
 *
 *     ComplianceDashboard:
 *       type: object
 *       properties:
 *         period:
 *           type: string
 *         dateRange:
 *           type: object
 *           properties:
 *             start:
 *               type: string
 *               format: date-time
 *             end:
 *               type: string
 *               format: date-time
 *         summary:
 *           type: object
 *           properties:
 *             totalReports:
 *               type: integer
 *             submittedReports:
 *               type: integer
 *             pendingReports:
 *               type: integer
 *             rejectedReports:
 *               type: integer
 *             complianceScore:
 *               type: number
 *         frameworkStatus:
 *           type: object
 *         upcomingDeadlines:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/ReportingDeadline'
 *         recentActivity:
 *           type: array
 *           items:
 *             type: object
 *         alerts:
 *           type: array
 *           items:
 *             type: object
 *
 *     ValidationResults:
 *       type: object
 *       properties:
 *         isValid:
 *           type: boolean
 *         score:
 *           type: number
 *         issues:
 *           type: array
 *           items:
 *             type: string
 *         recommendations:
 *           type: array
 *           items:
 *             type: string
 *         complianceChecks:
 *           type: object
 *           properties:
 *             dataCompleteness:
 *               type: number
 *             formatCompliance:
 *               type: number
 *             regulatoryAlignment:
 *               type: number
 *             dataQuality:
 *               type: number
 */

export default router;
