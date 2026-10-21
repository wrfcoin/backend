/**
 * ISO 20022 Cross-Border Payment Processing
 * Enhanced implementation for international transfers and SWIFT integration
 */

const crypto = require('crypto');
const xml2js = require('xml2js');
const { appLogger } = require('../server/utils/logger');

class CrossBorderPaymentProcessor {
  constructor() {
    this.swiftNetworkNodes = new Map();
    this.correspondentBanks = new Map();
    this.complianceRules = new Map();
    this.exchangeRates = new Map();
    this.transactionQueue = [];

    this.initializeSwiftNetwork();
    this.initializeComplianceRules();
  }

  // Initialize SWIFT network simulation
  initializeSwiftNetwork() {
    // Major SWIFT network nodes
    this.swiftNetworkNodes.set('US', {
      bic: 'CHASUS33XXX',
      name: 'JPMorgan Chase Bank',
      country: 'US',
      currency: 'USD',
      routingCapabilities: ['EUR', 'GBP', 'JPY', 'WRF'],
    });

    this.swiftNetworkNodes.set('EU', {
      bic: 'DEUTDEFFXXX',
      name: 'Deutsche Bank AG',
      country: 'DE',
      currency: 'EUR',
      routingCapabilities: ['USD', 'GBP', 'CHF', 'WRF'],
    });

    this.swiftNetworkNodes.set('UK', {
      bic: 'HBUKGB4BXXX',
      name: 'HSBC Bank plc',
      country: 'GB',
      currency: 'GBP',
      routingCapabilities: ['USD', 'EUR', 'JPY', 'WRF'],
    });

    this.swiftNetworkNodes.set('WRFCOIN', {
      bic: 'WRFCXXX0XXX',
      name: 'Wrfcoin Climate Bank',
      country: 'VIRTUAL',
      currency: 'WRF',
      routingCapabilities: ['USD', 'EUR', 'GBP', 'JPY'],
    });
  }

  // Initialize compliance rules for different jurisdictions
  initializeComplianceRules() {
    // US compliance (FinCEN, OFAC)
    this.complianceRules.set('US', {
      maxTransactionAmount: 10000, // USD threshold for CTR
      kycRequired: true,
      ofacScreening: true,
      reportingThreshold: 10000,
      allowedCountries: ['CA', 'MX', 'EU', 'UK', 'AU', 'JP'],
      restrictedCountries: ['IR', 'KP', 'SY'],
      additionalChecks: ['terrorist_screening', 'sanctions_list'],
    });

    // EU compliance (AMLD, PSD2)
    this.complianceRules.set('EU', {
      maxTransactionAmount: 15000, // EUR threshold
      kycRequired: true,
      amlScreening: true,
      reportingThreshold: 15000,
      allowedCountries: ['US', 'CA', 'UK', 'CH', 'AU', 'JP'],
      restrictedCountries: ['IR', 'KP', 'AF'],
      additionalChecks: ['psd2_compliance', 'gdpr_consent'],
    });

    // WRF-specific compliance
    this.complianceRules.set('WRF', {
      maxTransactionAmount: 1000000, // WRF tokens
      climateDataRequired: true,
      carbonOffsetValidation: true,
      environmentalImpactAssessment: true,
      allowedPurposes: [
        'climate_finance',
        'carbon_credits',
        'weather_data',
        'green_bonds',
      ],
      restrictedPurposes: ['fossil_fuel_finance', 'deforestation'],
    });
  }

  // Main cross-border payment processing function
  async processCrossBorderPayment(paymentInstruction) {
    try {
      const processingId = crypto.randomUUID();

      // Validate ISO 20022 message structure
      await this.validateISO20022Structure(paymentInstruction);

      // Determine optimal routing path
      const routingPath =
        await this.determineOptimalRouting(paymentInstruction);

      // Perform compliance checks
      const complianceResult = await this.performComplianceChecks(
        paymentInstruction,
        routingPath
      );

      if (!complianceResult.approved) {
        throw new Error(`Compliance check failed: ${complianceResult.reason}`);
      }

      // Execute payment through SWIFT network
      const swiftMessage = await this.generateSWIFTMessage(
        paymentInstruction,
        routingPath
      );
      const executionResult = await this.executeSWIFTTransaction(
        swiftMessage,
        routingPath
      );

      // Generate confirmation and reporting
      const confirmation = await this.generatePaymentConfirmation(
        paymentInstruction,
        executionResult
      );

      return {
        success: true,
        processingId,
        routingPath,
        executionResult,
        confirmation,
        complianceStatus: complianceResult.status,
      };
    } catch (error) {
      await this.logCrossBorderError(paymentInstruction, error);
      throw error;
    }
  }

  // Validate ISO 20022 message structure
  async validateISO20022Structure(paymentInstruction) {
    const requiredFields = [
      'messageId',
      'creationDateTime',
      'paymentInformation.debtorAccount',
      'paymentInformation.creditorAccount',
      'paymentInformation.instructedAmount',
      'businessApplicationHeader',
    ];

    for (const field of requiredFields) {
      if (!this.getNestedProperty(paymentInstruction, field)) {
        throw new Error(`Missing required ISO 20022 field: ${field}`);
      }
    }

    // Validate BIC codes
    const debtorBIC =
      paymentInstruction.paymentInformation?.debtorAgent?.finInstnId?.bicFi;
    const creditorBIC =
      paymentInstruction.paymentInformation?.creditorAgent?.finInstnId?.bicFi;

    if (!this.isValidBIC(debtorBIC) || !this.isValidBIC(creditorBIC)) {
      throw new Error('Invalid BIC code in payment instruction');
    }

    // Validate currency codes
    const currency =
      paymentInstruction.paymentInformation?.instructedAmount?.currency;
    if (!this.isValidCurrencyCode(currency)) {
      throw new Error(`Invalid currency code: ${currency}`);
    }

    return true;
  }

  // Determine optimal routing path for cross-border payment
  async determineOptimalRouting(paymentInstruction) {
    const debtorCountry = this.extractCountryFromBIC(
      paymentInstruction.paymentInformation.debtorAgent.finInstnId.bicFi
    );
    const creditorCountry = this.extractCountryFromBIC(
      paymentInstruction.paymentInformation.creditorAgent.finInstnId.bicFi
    );
    const currency =
      paymentInstruction.paymentInformation.instructedAmount.currency;
    const amount = parseFloat(
      paymentInstruction.paymentInformation.instructedAmount.value
    );

    // Direct routing for same country
    if (debtorCountry === creditorCountry) {
      return {
        type: 'direct',
        hops: 1,
        intermediaries: [],
        estimatedTime: '2-4 hours',
        fees: this.calculateDirectFees(amount, currency),
      };
    }

    // Find optimal correspondent banking path
    const correspondentPath = await this.findCorrespondentPath(
      debtorCountry,
      creditorCountry,
      currency
    );

    if (correspondentPath) {
      return {
        type: 'correspondent',
        hops: correspondentPath.length,
        intermediaries: correspondentPath,
        estimatedTime: this.estimateTransferTime(correspondentPath.length),
        fees: this.calculateCorrespondentFees(
          amount,
          currency,
          correspondentPath.length
        ),
      };
    }

    // Fallback to multi-hop routing
    const multiHopPath = await this.findMultiHopPath(
      debtorCountry,
      creditorCountry,
      currency
    );

    return {
      type: 'multi_hop',
      hops: multiHopPath.length,
      intermediaries: multiHopPath,
      estimatedTime: this.estimateTransferTime(multiHopPath.length),
      fees: this.calculateMultiHopFees(amount, currency, multiHopPath.length),
    };
  }

  // Perform comprehensive compliance checks
  async performComplianceChecks(paymentInstruction, routingPath) {
    const checks = [];
    const debtorCountry = this.extractCountryFromBIC(
      paymentInstruction.paymentInformation.debtorAgent.finInstnId.bicFi
    );
    const creditorCountry = this.extractCountryFromBIC(
      paymentInstruction.paymentInformation.creditorAgent.finInstnId.bicFi
    );
    const amount = parseFloat(
      paymentInstruction.paymentInformation.instructedAmount.value
    );
    const currency =
      paymentInstruction.paymentInformation.instructedAmount.currency;

    // Run all independent compliance checks concurrently
    const compliancePromises = [];

    const senderRules = this.complianceRules.get(debtorCountry);
    if (senderRules) {
      compliancePromises.push(this.checkSenderCompliance(paymentInstruction, senderRules));
    }

    const recipientRules = this.complianceRules.get(creditorCountry);
    if (recipientRules) {
      compliancePromises.push(this.checkRecipientCompliance(paymentInstruction, recipientRules));
    }

    if (currency === 'WRF') {
      compliancePromises.push(this.checkClimateFinanceCompliance(paymentInstruction));
    }

    compliancePromises.push(this.performSanctionsScreening(paymentInstruction));
    compliancePromises.push(this.performAMLRiskAssessment(paymentInstruction, amount));

    checks.push(...await Promise.all(compliancePromises));

    // Aggregate compliance results
    const failedChecks = checks.filter(check => !check.passed);

    if (failedChecks.length > 0) {
      return {
        approved: false,
        status: 'rejected',
        reason: failedChecks.map(check => check.reason).join('; '),
        failedChecks: failedChecks.map(check => check.type),
      };
    }

    return {
      approved: true,
      status: 'approved',
      riskScore: this.calculateOverallRiskScore(checks),
      completedChecks: checks.map(check => check.type),
    };
  }

  // Generate SWIFT MT/ISO 20022 message
  async generateSWIFTMessage(paymentInstruction, routingPath) {
    const messageType = this.determineSWIFTMessageType(
      paymentInstruction,
      routingPath
    );

    if (messageType === 'pacs.008') {
      return await this.generatePacs008Message(paymentInstruction, routingPath);
    } else if (messageType === 'pacs.009') {
      return await this.generatePacs009Message(paymentInstruction, routingPath);
    }

    throw new Error(`Unsupported SWIFT message type: ${messageType}`);
  }

  // Generate pacs.008 Customer Credit Transfer Initiation
  async generatePacs008Message(paymentInstruction, routingPath) {
    const messageId = `WRFCXBP${Date.now()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    const pacs008 = {
      Document: {
        $: { xmlns: 'urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08' },
        FIToFICstmrCdtTrf: {
          GrpHdr: {
            MsgId: messageId,
            CreDtTm: new Date().toISOString(),
            NbOfTxs: '1',
            SttlmInf: {
              SttlmMtd: 'CLRG',
              ClrSys: {
                Cd: 'WRF',
              },
            },
            InstgAgt: {
              FinInstnId: {
                BICFI: 'WRFCXXX0XXX',
              },
            },
            InstdAgt: {
              FinInstnId: {
                BICFI:
                  routingPath.intermediaries[0]?.bic ||
                  paymentInstruction.paymentInformation.creditorAgent.finInstnId
                    .bicFi,
              },
            },
          },
          CdtTrfTxInf: {
            PmtId: {
              InstrId: crypto.randomUUID(),
              EndToEndId:
                paymentInstruction.paymentInformation.endToEndId ||
                crypto.randomUUID(),
            },
            IntrBkSttlmAmt: {
              $: {
                Ccy: paymentInstruction.paymentInformation.instructedAmount
                  .currency,
              },
              _: paymentInstruction.paymentInformation.instructedAmount.value,
            },
            InstdAmt: {
              $: {
                Ccy: paymentInstruction.paymentInformation.instructedAmount
                  .currency,
              },
              _: paymentInstruction.paymentInformation.instructedAmount.value,
            },
            DbtrAgt: {
              FinInstnId: {
                BICFI:
                  paymentInstruction.paymentInformation.debtorAgent.finInstnId
                    .bicFi,
              },
            },
            Dbtr: {
              Nm:
                paymentInstruction.paymentInformation.debtor?.name ||
                'WRF Climate Participant',
              Id: {
                OrgId: {
                  AnyBIC:
                    paymentInstruction.paymentInformation.debtorAgent.finInstnId
                      .bicFi,
                },
              },
            },
            DbtrAcct: {
              Id: {
                IBAN: paymentInstruction.paymentInformation.debtorAccount
                  .identification.iban,
              },
            },
            CdtrAgt: {
              FinInstnId: {
                BICFI:
                  paymentInstruction.paymentInformation.creditorAgent.finInstnId
                    .bicFi,
              },
            },
            Cdtr: {
              Nm:
                paymentInstruction.paymentInformation.creditor?.name ||
                'Climate Finance Recipient',
              Id: {
                OrgId: {
                  AnyBIC:
                    paymentInstruction.paymentInformation.creditorAgent
                      .finInstnId.bicFi,
                },
              },
            },
            CdtrAcct: {
              Id: {
                IBAN: paymentInstruction.paymentInformation.creditorAccount
                  .identification.iban,
              },
            },
            RmtInf: {
              Ustrd:
                paymentInstruction.paymentInformation.remittanceInformation
                  ?.unstructured || 'Climate finance transaction',
            },
          },
        },
      },
    };

    // Add climate-specific extensions for WRF transactions
    if (
      paymentInstruction.paymentInformation.instructedAmount.currency === 'WRF'
    ) {
      pacs008.Document.FIToFICstmrCdtTrf.CdtTrfTxInf.SplmtryData = {
        PlcAndNm: 'ClimateFinanceData',
        Envlp: {
          ClmtFncData: {
            CrbCrdtOfst: paymentInstruction.climateData?.carbonCredits || '0',
            EnvImpctScr:
              paymentInstruction.climateData?.environmentalImpactScore || 'A+',
            WthrDtSrc:
              paymentInstruction.climateData?.weatherDataSource ||
              'station_network',
            SdgAlgnmt: paymentInstruction.climateData?.sdgAlignment || [
              '13',
              '14',
              '15',
            ],
          },
        },
      };
    }

    return this.convertToXML(pacs008);
  }

  // Execute SWIFT transaction through network
  async executeSWIFTTransaction(swiftMessage, routingPath) {
    const executionSteps = [];

    try {
      // Step 1: Send message to first intermediary
      const firstHop = await this.sendToFirstIntermediary(
        swiftMessage,
        routingPath
      );
      executionSteps.push(firstHop);

      // Step 2: Process through intermediaries
      for (let i = 0; i < routingPath.intermediaries.length; i++) {
        const intermediaryResult = await this.processThroughIntermediary(
          swiftMessage,
          routingPath.intermediaries[i],
          i
        );
        executionSteps.push(intermediaryResult);
      }

      // Step 3: Final settlement
      const settlementResult = await this.performFinalSettlement(
        swiftMessage,
        routingPath
      );
      executionSteps.push(settlementResult);

      return {
        success: true,
        transactionId: this.extractTransactionId(swiftMessage),
        executionSteps,
        totalTime: this.calculateTotalExecutionTime(executionSteps),
        finalStatus: 'settled',
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        executionSteps,
        failedAt: executionSteps.length,
        finalStatus: 'failed',
      };
    }
  }

  // Generate payment confirmation
  async generatePaymentConfirmation(paymentInstruction, executionResult) {
    const confirmationId = crypto.randomUUID();

    return {
      confirmationId,
      originalMessageId: paymentInstruction.messageId,
      status: executionResult.success ? 'completed' : 'failed',
      executionTime: executionResult.totalTime,
      transactionId: executionResult.transactionId,
      settlementDate: new Date().toISOString(),
      fees: this.calculateTotalFees(paymentInstruction, executionResult),
      exchangeRate: await this.getAppliedExchangeRate(paymentInstruction),
      complianceReference: this.generateComplianceReference(),
      climateImpact: await this.calculateClimateImpact(paymentInstruction),
    };
  }

  // Helper methods
  getNestedProperty(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  isValidBIC(bic) {
    const bicRegex = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
    return bicRegex.test(bic);
  }

  isValidCurrencyCode(currency) {
    const validCurrencies = [
      'USD',
      'EUR',
      'GBP',
      'JPY',
      'CHF',
      'CAD',
      'AUD',
      'WRF',
    ];
    return validCurrencies.includes(currency);
  }

  extractCountryFromBIC(bic) {
    if (!bic || bic.length < 6) return 'UNKNOWN';
    const countryCode = bic.substring(4, 6);

    const countryMapping = {
      US: 'US',
      DE: 'EU',
      GB: 'UK',
      FR: 'EU',
      IT: 'EU',
      ES: 'EU',
      NL: 'EU',
      CH: 'CH',
      CA: 'CA',
      JP: 'JP',
      AU: 'AU',
      XX: 'WRFCOIN',
    };

    return countryMapping[countryCode] || countryCode;
  }

  async findCorrespondentPath(from, to, currency) {
    // Simplified correspondent banking logic
    const majorCorrespondents = ['US', 'EU', 'UK'];

    if (
      majorCorrespondents.includes(from) &&
      majorCorrespondents.includes(to)
    ) {
      return [this.swiftNetworkNodes.get(from)];
    }

    // Route through major financial center
    if (
      !majorCorrespondents.includes(from) &&
      !majorCorrespondents.includes(to)
    ) {
      return [
        this.swiftNetworkNodes.get('US'),
        this.swiftNetworkNodes.get('EU'),
      ];
    }

    return [this.swiftNetworkNodes.get('US')];
  }

  async findMultiHopPath(from, to, currency) {
    return await this.findCorrespondentPath(from, to, currency);
  }

  calculateDirectFees(amount, currency) {
    const baseFee = currency === 'WRF' ? 0.1 : 25;
    const percentageFee = amount * 0.001;
    return baseFee + percentageFee;
  }

  calculateCorrespondentFees(amount, currency, hops) {
    const baseFee = this.calculateDirectFees(amount, currency);
    return baseFee + hops * 15;
  }

  calculateMultiHopFees(amount, currency, hops) {
    return this.calculateCorrespondentFees(amount, currency, hops) * 1.2;
  }

  estimateTransferTime(hops) {
    const baseTime = 2; // hours
    const additionalTime = (hops - 1) * 4;
    return `${baseTime + additionalTime}-${baseTime + additionalTime + 2} hours`;
  }

  async checkSenderCompliance(instruction, rules) {
    const amount = parseFloat(
      instruction.paymentInformation.instructedAmount.value
    );

    return {
      type: 'sender_compliance',
      passed: amount <= rules.maxTransactionAmount,
      reason:
        amount > rules.maxTransactionAmount
          ? 'Exceeds transaction limit'
          : null,
    };
  }

  async checkRecipientCompliance(instruction, rules) {
    return {
      type: 'recipient_compliance',
      passed: true,
      reason: null,
    };
  }

  async checkClimateFinanceCompliance(instruction) {
    const purpose = instruction.paymentInformation.purpose?.code;
    const allowedPurposes = ['CLDT', 'CCRD', 'GNBF']; // Climate data, carbon credits, green bonds

    return {
      type: 'climate_compliance',
      passed: !purpose || allowedPurposes.includes(purpose),
      reason:
        purpose && !allowedPurposes.includes(purpose)
          ? 'Not climate finance eligible'
          : null,
    };
  }

  async performSanctionsScreening(instruction) {
    // Simplified sanctions screening
    const restrictedEntities = ['BLOCKED_ENTITY_1', 'BLOCKED_ENTITY_2'];
    const debtorName = instruction.paymentInformation.debtor?.name || '';
    const creditorName = instruction.paymentInformation.creditor?.name || '';

    const isRestricted = restrictedEntities.some(
      entity => debtorName.includes(entity) || creditorName.includes(entity)
    );

    return {
      type: 'sanctions_screening',
      passed: !isRestricted,
      reason: isRestricted ? 'Entity appears on sanctions list' : null,
    };
  }

  async performAMLRiskAssessment(instruction, amount) {
    let riskScore = 0;

    // High amount risk
    if (amount > 50000) riskScore += 30;
    else if (amount > 10000) riskScore += 15;

    // High-risk countries (simplified)
    const highRiskCountries = ['AF', 'IR', 'KP'];
    const debtorCountry = this.extractCountryFromBIC(
      instruction.paymentInformation.debtorAgent.finInstnId.bicFi
    );
    const creditorCountry = this.extractCountryFromBIC(
      instruction.paymentInformation.creditorAgent.finInstnId.bicFi
    );

    if (
      highRiskCountries.includes(debtorCountry) ||
      highRiskCountries.includes(creditorCountry)
    ) {
      riskScore += 50;
    }

    return {
      type: 'aml_risk_assessment',
      passed: riskScore < 70,
      riskScore,
      reason: riskScore >= 70 ? 'High AML risk score' : null,
    };
  }

  calculateOverallRiskScore(checks) {
    const riskScores = checks
      .filter(check => check.riskScore)
      .map(check => check.riskScore);
    return riskScores.length > 0
      ? riskScores.reduce((a, b) => a + b, 0) / riskScores.length
      : 0;
  }

  determineSWIFTMessageType(instruction, routingPath) {
    return routingPath.type === 'direct' ? 'pacs.008' : 'pacs.009';
  }

  async generatePacs009Message(instruction, routingPath) {
    // Implementation for pacs.009 (Financial Institution Credit Transfer)
    return await this.generatePacs008Message(instruction, routingPath);
  }

  convertToXML(jsonObject) {
    const builder = new xml2js.Builder({
      rootName: 'Document',
      xmldec: { version: '1.0', encoding: 'UTF-8' },
    });
    return builder.buildObject(jsonObject.Document);
  }

  async sendToFirstIntermediary(message, routingPath) {
    return {
      step: 'first_intermediary',
      timestamp: new Date().toISOString(),
      status: 'success',
      duration: '00:00:02',
    };
  }

  async processThroughIntermediary(message, intermediary, index) {
    return {
      step: `intermediary_${index + 1}`,
      intermediary: intermediary.name,
      timestamp: new Date().toISOString(),
      status: 'success',
      duration: '00:00:05',
    };
  }

  async performFinalSettlement(message, routingPath) {
    return {
      step: 'final_settlement',
      timestamp: new Date().toISOString(),
      status: 'settled',
      duration: '00:00:01',
    };
  }

  extractTransactionId(swiftMessage) {
    return crypto.randomUUID();
  }

  calculateTotalExecutionTime(steps) {
    return steps.reduce((total, step) => total + 5, 0); // Simplified
  }

  calculateTotalFees(instruction, executionResult) {
    const amount = parseFloat(
      instruction.paymentInformation.instructedAmount.value
    );
    const currency = instruction.paymentInformation.instructedAmount.currency;
    return this.calculateDirectFees(amount, currency);
  }

  async getAppliedExchangeRate(instruction) {
    const currency = instruction.paymentInformation.instructedAmount.currency;
    if (currency === 'WRF') {
      return { from: 'WRF', to: 'USD', rate: 1.25 };
    }
    return null;
  }

  generateComplianceReference() {
    return `COMP-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  }

  async calculateClimateImpact(instruction) {
    if (instruction.paymentInformation.instructedAmount.currency === 'WRF') {
      return {
        carbonFootprintReduction: '15.5 kg CO2',
        sdgContribution: ['Climate Action', 'Life Below Water', 'Life on Land'],
        environmentalScore: 'A+',
      };
    }
    return null;
  }

  async logCrossBorderError(instruction, error) {
    appLogger.error('Cross-border payment error', {
      messageId: instruction.messageId,
      error: error.message
    });
  }
}

// Express middleware for cross-border payments
const crossBorderProcessor = new CrossBorderPaymentProcessor();

const crossBorderMiddleware = {
  processPayment: async (req, res, next) => {
    try {
      const paymentInstruction = req.body;
      const result =
        await crossBorderProcessor.processCrossBorderPayment(
          paymentInstruction
        );
      res.json(result);
    } catch (error) {
      next(error);
    }
  },

  validateInstruction: async (req, res, next) => {
    try {
      const paymentInstruction = req.body;
      await crossBorderProcessor.validateISO20022Structure(paymentInstruction);
      res.json({ valid: true, message: 'Payment instruction is valid' });
    } catch (error) {
      res.status(400).json({ valid: false, error: error.message });
    }
  },

  getRoutingOptions: async (req, res, next) => {
    try {
      const { fromCountry, toCountry, currency, amount } = req.query;
      const mockInstruction = {
        paymentInformation: {
          debtorAgent: { finInstnId: { bicFi: `TEST${fromCountry}XX` } },
          creditorAgent: { finInstnId: { bicFi: `TEST${toCountry}XX` } },
          instructedAmount: { currency, value: amount },
        },
      };

      const routingOptions =
        await crossBorderProcessor.determineOptimalRouting(mockInstruction);
      res.json(routingOptions);
    } catch (error) {
      next(error);
    }
  },
};

module.exports = {
  CrossBorderPaymentProcessor,
  crossBorderMiddleware,
  crossBorderProcessor,
};
