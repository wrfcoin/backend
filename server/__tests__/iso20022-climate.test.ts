const request = require('supertest');
const express = require('express');
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  jest,
} from '@jest/globals';
import iso20022ClimateRoutes from '../routes/iso20022-climate-routes.js';

// Mock services
jest.mock('../services/iso20022-climate-service.js');
jest.mock('../services/iso20022-validator.js');
jest.mock('../services/iso20022-error-handler.js');
jest.mock('../services/tcfd-analyzer.js');
jest.mock('../services/tcfd-report-generator.js');
jest.mock('../services/climate-finance-security.js');

const app = express();
app.use(express.json());
app.use('/api/v1/climate-finance', iso20022ClimateRoutes);

// Mock valid XML message for testing
const validXmlMessage = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.09">
  <FIToFICstmrCdtTrf>
    <GrpHdr>
      <MsgId>MSG-CLIMATE-001</MsgId>
      <CreDtTm>2024-01-15T10:30:00Z</CreDtTm>
      <NbOfTxs>1</NbOfTxs>
    </GrpHdr>
  </FIToFICstmrCdtTrf>
</Document>`;

describe('ISO20022 Climate Finance API', () => {
  beforeAll(() => {
    // Setup test environment
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL =
      'postgresql://test:test@localhost:5432/wrfcoin_test';
  });

  afterAll(() => {
    // Cleanup
    jest.clearAllMocks();
  });

  describe('POST /api/v1/climate-finance/messages', () => {
    const validXmlMessage = `
      <?xml version="1.0" encoding="UTF-8"?>
      <Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.09">
        <FIToFICstmrCdtTrf>
          <GrpHdr>
            <MsgId>MSG-CLIMATE-001</MsgId>
            <CreDtTm>2024-01-15T10:30:00Z</CreDtTm>
            <NbOfTxs>1</NbOfTxs>
            <SettlmInf>
              <SettlmMtd>CLRG</SettlmMtd>
            </SettlmInf>
            <InstgAgt>
              <FinInstnId>
                <BICFI>WRFCGB2L</BICFI>
                <Nm>Wrfcoin Climate Finance</Nm>
              </FinInstnId>
            </InstgAgt>
          </GrpHdr>
          <CdtTrfTxInf>
            <PmtId>
              <InstrId>CLIMATE-PAY-001</InstrId>
              <EndToEndId>E2E-CLIMATE-001</EndToEndId>
              <TxId>TXN-CLIMATE-001</TxId>
            </PmtId>
            <IntrBkSttlmAmt Ccy="USD">10000.00</IntrBkSttlmAmt>
            <ChrgBr>SLEV</ChrgBr>
            <Dbtr>
              <Nm>Climate Data Provider Ltd</Nm>
              <PstlAdr>
                <Ctry>GB</Ctry>
              </PstlAdr>
            </Dbtr>
            <DbtrAcct>
              <Id>
                <IBAN>GB33BUKB20201555555555</IBAN>
              </Id>
            </DbtrAcct>
            <Cdtr>
              <Nm>Weather Station Network Inc</Nm>
              <PstlAdr>
                <Ctry>US</Ctry>
              </PstlAdr>
            </Cdtr>
            <CdtrAcct>
              <Id>
                <IBAN>US64SVBKUS6S3300958879</IBAN>
              </Id>
            </CdtrAcct>
            <RmtInf>
              <Ustrd>Climate data validation payment for PROJECT-CLIMATE-001 CARBON:VCS1234</Ustrd>
            </RmtInf>
          </CdtTrfTxInf>
        </FIToFICstmrCdtTrf>
      </Document>
    `;

    test('should process valid climate finance message', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/messages')
        .send({
          xmlMessage: validXmlMessage,
          messageType: 'climate_data_payment',
          securityLevel: 'standard',
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('messageId');
      expect(response.body.data).toHaveProperty('status', 'processed');
      expect(response.body.data).toHaveProperty('validationResults');
    });

    test('should reject message with invalid XML', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/messages')
        .send({
          xmlMessage: 'invalid-xml',
          messageType: 'climate_data_payment',
        })
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('processing failed');
    });

    test('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/messages')
        .send({
          messageType: 'climate_data_payment',
          // Missing xmlMessage
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });

    test('should validate message type', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/messages')
        .send({
          xmlMessage: validXmlMessage,
          messageType: 'invalid_type',
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            msg: 'Invalid message type',
          }),
        ])
      );
    });

    test('should handle carbon credit transfer message', async () => {
      const carbonCreditXml = validXmlMessage.replace(
        'Climate data validation payment',
        'Carbon credit transfer for VCS-12345 registry'
      );

      const response = await request(app)
        .post('/api/v1/climate-finance/messages')
        .send({
          xmlMessage: carbonCreditXml,
          messageType: 'carbon_credit_transfer',
          securityLevel: 'enhanced',
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.messageId).toBeDefined();
    });

    test('should apply enhanced security for high-value transactions', async () => {
      const highValueXml = validXmlMessage.replace('10000.00', '1000000.00');

      const response = await request(app)
        .post('/api/v1/climate-finance/messages')
        .send({
          xmlMessage: highValueXml,
          messageType: 'climate_fund_disbursement',
          securityLevel: 'maximum',
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.securityId).toBeDefined();
    });
  });

  describe('POST /api/v1/climate-finance/reports/tcfd', () => {
    test('should generate TCFD report successfully', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/reports/tcfd')
        .send({
          reportingPeriod: '2024-Q1',
          messageIds: ['MSG-CLIMATE-001', 'MSG-CLIMATE-002'],
          reportType: 'quarterly',
          outputFormats: ['json', 'html'],
          includeAnalytics: true,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('reportId');
      expect(response.body.data).toHaveProperty('reportData');
      expect(response.body.data).toHaveProperty('complianceAssessment');
      expect(response.body.data).toHaveProperty('analytics');
      expect(response.body.data.outputs).toHaveLength(2);
    });

    test('should validate required report parameters', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/reports/tcfd')
        .send({
          reportType: 'quarterly',
          // Missing reportingPeriod and messageIds
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });

    test('should handle annual report generation', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/reports/tcfd')
        .send({
          reportingPeriod: '2024',
          messageIds: Array.from({ length: 100 }, (_, i) => `MSG-${i}`),
          reportType: 'annual',
          outputFormats: ['pdf', 'xml'],
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.reportId).toMatch(/TCFD.*2024.*annual/);
    });

    test('should respect rate limiting for report generation', async () => {
      // Make multiple rapid requests
      const requests = Array.from({ length: 10 }, () =>
        request(app)
          .post('/api/v1/climate-finance/reports/tcfd')
          .send({
            reportingPeriod: '2024-Q1',
            messageIds: ['MSG-TEST'],
          })
      );

      const responses = await Promise.allSettled(requests);
      const rateLimited = responses.some(
        result =>
          result.status === 'fulfilled' && (result.value as any).status === 429
      );

      expect(rateLimited).toBe(true);
    });
  });

  describe('POST /api/v1/climate-finance/analysis/tcfd-compliance', () => {
    test('should perform comprehensive TCFD analysis', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/analysis/tcfd-compliance')
        .send({
          messageIds: ['MSG-CLIMATE-001', 'MSG-CLIMATE-002'],
          analysisType: 'comprehensive',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('requirementsAnalysis');
      expect(response.body.data).toHaveProperty('riskAssessment');
      expect(response.body.data).toHaveProperty('scenarioAnalysis');
      expect(response.body.data).toHaveProperty('tcfdMapping');
    });

    test('should perform basic TCFD analysis', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/analysis/tcfd-compliance')
        .send({
          messageIds: ['MSG-CLIMATE-001'],
          analysisType: 'basic',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.analysisDate).toBeDefined();
    });

    test('should validate message IDs parameter', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/analysis/tcfd-compliance')
        .send({
          analysisType: 'comprehensive',
          // Missing messageIds
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/v1/climate-finance/validation/mapping', () => {
    test('should validate message against mapping rules', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/validation/mapping')
        .send({
          messageData: {
            messageId: 'MSG-TEST-001',
            messageType: 'climate_data_payment',
            principalAmount: '10000.00',
            currency: 'USD',
          },
          mappingId: 'tcfd-metrics-mapping',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('isValid');
      expect(response.body.data).toHaveProperty('complianceScore');
    });

    test('should require both messageData and mappingId', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/validation/mapping')
        .send({
          messageData: { messageId: 'test' },
          // Missing mappingId
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });
  });

  describe('POST /api/v1/climate-finance/security/incidents', () => {
    test('should handle security incident reporting', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/security/incidents')
        .send({
          incidentType: 'unauthorized_access',
          incidentDetails: {
            timestamp: new Date().toISOString(),
            source: '192.168.1.100',
            attemptedResource: 'MSG-CLIMATE-001',
          },
          resourceId: 'MSG-CLIMATE-001',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('severity');
      expect(response.body.data).toHaveProperty('immediateActions');
    });

    test('should validate incident type', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/security/incidents')
        .send({
          incidentType: 'invalid_type',
          incidentDetails: {},
          resourceId: 'MSG-TEST',
        })
        .expect(400);

      expect(response.body.success).toBe(false);
    });

    test('should handle data breach incidents with high severity', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/security/incidents')
        .send({
          incidentType: 'data_breach',
          incidentDetails: {
            affectedRecords: 1000,
            dataTypes: ['personal', 'financial'],
            containmentStatus: 'in_progress',
          },
          resourceId: 'SYSTEM-WIDE',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.severity).toBe('critical');
    });
  });

  describe('POST /api/v1/climate-finance/security/rotate-keys', () => {
    test('should rotate encryption keys', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/security/rotate-keys')
        .send({
          resourceType: 'message',
          resourceId: 'MSG-CLIMATE-001',
          forceRotation: false,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('rotated');
      expect(response.body.data).toHaveProperty('newKeyId');
      expect(response.body.data).toHaveProperty('rotationReason');
    });

    test('should force key rotation when requested', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/security/rotate-keys')
        .send({
          resourceType: 'report',
          resourceId: 'TCFD-2024-Q1',
          forceRotation: true,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.rotated).toBe(true);
    });
  });

  describe('GET /api/v1/climate-finance/health', () => {
    test('should return health status', async () => {
      const response = await request(app)
        .get('/api/v1/climate-finance/health')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('status', 'healthy');
      expect(response.body.data).toHaveProperty('services');
      expect(response.body.data).toHaveProperty('uptime');
      expect(response.body.data).toHaveProperty('version');
    });
  });

  describe('GET /api/v1/climate-finance/metrics', () => {
    test('should return processing metrics', async () => {
      const response = await request(app)
        .get('/api/v1/climate-finance/metrics')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('messagesProcessed');
      expect(response.body.data).toHaveProperty('processingTimes');
      expect(response.body.data).toHaveProperty('validationResults');
      expect(response.body.data).toHaveProperty('tcfdCompliance');
      expect(response.body.data).toHaveProperty('security');
    });
  });

  describe('GET /api/v1/climate-finance/config/mapping-rules', () => {
    test('should return available mapping rules', async () => {
      const response = await request(app)
        .get('/api/v1/climate-finance/config/mapping-rules')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('available');
      expect(Array.isArray(response.body.data.available)).toBe(true);
      expect(response.body.data.available.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/v1/climate-finance/config/security-policies', () => {
    test('should return security policies', async () => {
      const response = await request(app)
        .get('/api/v1/climate-finance/config/security-policies')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('encryption');
      expect(response.body.data).toHaveProperty('signatures');
      expect(response.body.data).toHaveProperty('accessControl');
      expect(response.body.data).toHaveProperty('audit');
      expect(response.body.data).toHaveProperty('compliance');
    });
  });

  describe('Error Handling', () => {
    test('should handle internal server errors gracefully', async () => {
      // This test would require mocking services to throw errors
      const response = await request(app)
        .post('/api/v1/climate-finance/messages')
        .send({
          xmlMessage: 'trigger-error',
          messageType: 'climate_data_payment',
        });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body.success).toBe(false);
      expect(response.body).toHaveProperty('error');
    });

    test('should include error tracking information', async () => {
      const response = await request(app)
        .post('/api/v1/climate-finance/messages')
        .send({
          xmlMessage: 'trigger-error',
          messageType: 'climate_data_payment',
        });

      expect(response.body).toHaveProperty('timestamp');
      expect(response.body).toHaveProperty('path');
      expect(response.body).toHaveProperty('method');
    });
  });

  describe('Rate Limiting', () => {
    test('should apply strict rate limiting to message processing', async () => {
      const requests = Array.from({ length: 15 }, () =>
        request(app).post('/api/v1/climate-finance/messages').send({
          xmlMessage: validXmlMessage,
          messageType: 'climate_data_payment',
        })
      );

      const responses = await Promise.allSettled(requests);
      const rateLimited = responses.some(
        result =>
          result.status === 'fulfilled' && (result.value as any).status === 429
      );

      expect(rateLimited).toBe(true);
    });
  });

  describe('Integration Tests', () => {
    test('should process message end-to-end with TCFD reporting', async () => {
      // 1. Process climate message
      const messageResponse = await request(app)
        .post('/api/v1/climate-finance/messages')
        .send({
          xmlMessage: validXmlMessage,
          messageType: 'climate_data_payment',
          securityLevel: 'enhanced',
        })
        .expect(201);

      const messageId = messageResponse.body.data.messageId;

      // 2. Generate TCFD report including this message
      const reportResponse = await request(app)
        .post('/api/v1/climate-finance/reports/tcfd')
        .send({
          reportingPeriod: '2024-Q1',
          messageIds: [messageId],
          reportType: 'quarterly',
          outputFormats: ['json'],
        })
        .expect(200);

      expect(reportResponse.body.data.reportId).toBeDefined();
      expect(reportResponse.body.data.reportData).toBeDefined();

      // 3. Analyze TCFD compliance
      const analysisResponse = await request(app)
        .post('/api/v1/climate-finance/analysis/tcfd-compliance')
        .send({
          messageIds: [messageId],
          analysisType: 'comprehensive',
        })
        .expect(200);

      expect(analysisResponse.body.data.tcfdMapping).toBeDefined();
    });
  });
});

// Helper functions for test data
function createValidClimateMessage(overrides: any = {}): string {
  const defaults = {
    messageId: 'MSG-TEST-' + Date.now(),
    amount: '10000.00',
    currency: 'USD',
    debtor: 'Climate Data Provider Ltd',
    creditor: 'Weather Station Network Inc',
    purpose: 'Climate data validation payment',
  };

  const data = { ...defaults, ...overrides };

  return `
    <?xml version="1.0" encoding="UTF-8"?>
    <Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.09">
      <FIToFICstmrCdtTrf>
        <GrpHdr>
          <MsgId>${data.messageId}</MsgId>
          <CreDtTm>${new Date().toISOString()}</CreDtTm>
          <NbOfTxs>1</NbOfTxs>
        </GrpHdr>
        <CdtTrfTxInf>
          <PmtId>
            <InstrId>${data.messageId}-INSTR</InstrId>
            <EndToEndId>${data.messageId}-E2E</EndToEndId>
          </PmtId>
          <IntrBkSttlmAmt Ccy="${data.currency}">${data.amount}</IntrBkSttlmAmt>
          <Dbtr>
            <Nm>${data.debtor}</Nm>
          </Dbtr>
          <Cdtr>
            <Nm>${data.creditor}</Nm>
          </Cdtr>
          <RmtInf>
            <Ustrd>${data.purpose}</Ustrd>
          </RmtInf>
        </CdtTrfTxInf>
      </FIToFICstmrCdtTrf>
    </Document>
  `;
}

export { createValidClimateMessage };
