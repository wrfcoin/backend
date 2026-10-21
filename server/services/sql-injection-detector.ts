/**
 * SQL Injection Detector Service
 * Task 104.10: Database Security Monitoring
 *
 * Advanced SQL injection detection with:
 * - Pattern-based detection (regex)
 * - Tokenization analysis
 * - Behavioral analysis (frequency, source IP)
 * - Machine learning-inspired scoring
 * - Integration with IntegrityAlert interface
 */

import { securityLogger } from '../utils/logger.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Detection result interface
 */
export interface SQLInjectionDetectionResult {
  isInjection: boolean;
  confidence: number; // 0-1
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  detectedPatterns: DetectedPattern[];
  riskScore: number; // 0-100
  recommendation: string;
  metadata: {
    inputLength: number;
    normalizedInput: string;
    analysisTime: number;
  };
}

interface DetectedPattern {
  pattern: string;
  category: PatternCategory;
  matchedText: string;
  position: number;
  weight: number;
}

type PatternCategory =
  | 'CLASSIC_INJECTION'
  | 'UNION_BASED'
  | 'BOOLEAN_BASED'
  | 'TIME_BASED'
  | 'ERROR_BASED'
  | 'STACKED_QUERIES'
  | 'COMMENT_BASED'
  | 'ENCODING_EVASION'
  | 'FUNCTION_ABUSE'
  | 'METADATA_ACCESS';

/**
 * IntegrityAlert compatible interface
 */
export interface SQLInjectionAlert {
  id: string;
  type: 'sql_injection_attempt';
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: string;
  timestamp: Date;
  details: {
    input: string;
    detectedPatterns: DetectedPattern[];
    confidence: number;
    riskScore: number;
    sourceIp?: string;
    userId?: string;
    endpoint?: string;
  };
  resolved: boolean;
}

/**
 * Behavioral analysis data
 */
interface BehavioralContext {
  sourceIp: string;
  recentAttempts: number;
  uniquePatternCount: number;
  lastAttemptTime: Date;
  blockedCount: number;
}

// ============================================================================
// SQL Injection Patterns (Extended from input-sanitizer.ts)
// ============================================================================

const INJECTION_PATTERNS: {
  pattern: RegExp;
  category: PatternCategory;
  weight: number;
  description: string;
}[] = [
  // Classic SQL Injection Patterns
  {
    pattern: /('|")\s*(OR|AND)\s*('|"|\d+)\s*=\s*\1/gi,
    category: 'CLASSIC_INJECTION',
    weight: 90,
    description: "Classic OR/AND '1'='1' pattern",
  },
  {
    pattern: /('|")\s*OR\s+('|")?1('|")?\s*=\s*('|")?1('|")?/gi,
    category: 'CLASSIC_INJECTION',
    weight: 95,
    description: "Classic OR 1=1 pattern",
  },
  {
    pattern: /('|")\s*OR\s+('|")?true('|")?/gi,
    category: 'BOOLEAN_BASED',
    weight: 85,
    description: "Boolean true injection",
  },
  {
    pattern: /;\s*(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE)\s/gi,
    category: 'STACKED_QUERIES',
    weight: 100,
    description: "Stacked destructive query",
  },
  {
    pattern: /;\s*--/g,
    category: 'COMMENT_BASED',
    weight: 70,
    description: "Comment after semicolon",
  },
  {
    pattern: /--\s*$/gm,
    category: 'COMMENT_BASED',
    weight: 60,
    description: "Trailing comment",
  },
  {
    pattern: /\/\*[\s\S]*?\*\//g,
    category: 'COMMENT_BASED',
    weight: 50,
    description: "Block comment",
  },
  {
    pattern: /#\s*$/gm,
    category: 'COMMENT_BASED',
    weight: 40,
    description: "MySQL comment",
  },

  // UNION-based Injection
  {
    pattern: /UNION\s+(ALL\s+)?SELECT/gi,
    category: 'UNION_BASED',
    weight: 95,
    description: "UNION SELECT pattern",
  },
  {
    pattern: /UNION\s+ALL\s+SELECT\s+NULL/gi,
    category: 'UNION_BASED',
    weight: 98,
    description: "UNION SELECT NULL (column enumeration)",
  },
  {
    pattern: /ORDER\s+BY\s+\d+/gi,
    category: 'UNION_BASED',
    weight: 60,
    description: "ORDER BY number (column count discovery)",
  },

  // Time-based Blind Injection
  {
    pattern: /SLEEP\s*\(\s*\d+\s*\)/gi,
    category: 'TIME_BASED',
    weight: 90,
    description: "MySQL SLEEP function",
  },
  {
    pattern: /WAITFOR\s+DELAY\s+['"]?\d/gi,
    category: 'TIME_BASED',
    weight: 90,
    description: "SQL Server WAITFOR DELAY",
  },
  {
    pattern: /PG_SLEEP\s*\(\s*\d+\s*\)/gi,
    category: 'TIME_BASED',
    weight: 90,
    description: "PostgreSQL pg_sleep function",
  },
  {
    pattern: /BENCHMARK\s*\(\s*\d+/gi,
    category: 'TIME_BASED',
    weight: 85,
    description: "MySQL BENCHMARK function",
  },

  // Error-based Injection
  {
    pattern: /EXTRACTVALUE\s*\(/gi,
    category: 'ERROR_BASED',
    weight: 80,
    description: "MySQL EXTRACTVALUE error injection",
  },
  {
    pattern: /UPDATEXML\s*\(/gi,
    category: 'ERROR_BASED',
    weight: 80,
    description: "MySQL UPDATEXML error injection",
  },
  {
    pattern: /EXP\s*\(\s*~\s*\(/gi,
    category: 'ERROR_BASED',
    weight: 85,
    description: "MySQL EXP overflow error",
  },
  {
    pattern: /CONVERT\s*\(\s*INT/gi,
    category: 'ERROR_BASED',
    weight: 70,
    description: "SQL Server CONVERT error",
  },

  // Encoding Evasion
  {
    pattern: /CHAR\s*\(\s*\d+(\s*,\s*\d+)*\s*\)/gi,
    category: 'ENCODING_EVASION',
    weight: 75,
    description: "CHAR() string encoding",
  },
  {
    pattern: /0x[0-9a-fA-F]+/g,
    category: 'ENCODING_EVASION',
    weight: 50,
    description: "Hex-encoded string",
  },
  {
    pattern: /UNHEX\s*\(/gi,
    category: 'ENCODING_EVASION',
    weight: 70,
    description: "MySQL UNHEX function",
  },
  {
    pattern: /FROM_BASE64\s*\(/gi,
    category: 'ENCODING_EVASION',
    weight: 70,
    description: "Base64 decode function",
  },
  {
    pattern: /%27|%22|%3B|%2D%2D/gi,
    category: 'ENCODING_EVASION',
    weight: 60,
    description: "URL-encoded SQL characters",
  },

  // Function Abuse
  {
    pattern: /LOAD_FILE\s*\(/gi,
    category: 'FUNCTION_ABUSE',
    weight: 95,
    description: "MySQL LOAD_FILE (file access)",
  },
  {
    pattern: /INTO\s+(OUTFILE|DUMPFILE)/gi,
    category: 'FUNCTION_ABUSE',
    weight: 100,
    description: "File write attempt",
  },
  {
    pattern: /EXEC\s*\(/gi,
    category: 'FUNCTION_ABUSE',
    weight: 90,
    description: "SQL Server EXEC",
  },
  {
    pattern: /XP_CMDSHELL/gi,
    category: 'FUNCTION_ABUSE',
    weight: 100,
    description: "SQL Server command shell",
  },
  {
    pattern: /SP_EXECUTESQL/gi,
    category: 'FUNCTION_ABUSE',
    weight: 85,
    description: "SQL Server dynamic SQL",
  },

  // Metadata Access
  {
    pattern: /INFORMATION_SCHEMA\./gi,
    category: 'METADATA_ACCESS',
    weight: 80,
    description: "Information schema access",
  },
  {
    pattern: /SYS\.(TABLES|COLUMNS|DATABASES)/gi,
    category: 'METADATA_ACCESS',
    weight: 85,
    description: "SQL Server sys catalog access",
  },
  {
    pattern: /PG_CATALOG\./gi,
    category: 'METADATA_ACCESS',
    weight: 80,
    description: "PostgreSQL catalog access",
  },
  {
    pattern: /@@VERSION/gi,
    category: 'METADATA_ACCESS',
    weight: 60,
    description: "Version discovery",
  },
  {
    pattern: /DATABASE\s*\(\s*\)/gi,
    category: 'METADATA_ACCESS',
    weight: 50,
    description: "Current database discovery",
  },
  {
    pattern: /USER\s*\(\s*\)/gi,
    category: 'METADATA_ACCESS',
    weight: 50,
    description: "Current user discovery",
  },

  // Boolean-based Blind Injection
  {
    pattern: /AND\s+\d+\s*=\s*\d+/gi,
    category: 'BOOLEAN_BASED',
    weight: 60,
    description: "Boolean AND condition",
  },
  {
    pattern: /OR\s+\d+\s*=\s*\d+/gi,
    category: 'BOOLEAN_BASED',
    weight: 65,
    description: "Boolean OR condition",
  },
  {
    pattern: /IF\s*\(\s*\d+\s*=\s*\d+/gi,
    category: 'BOOLEAN_BASED',
    weight: 70,
    description: "IF condition test",
  },
  {
    pattern: /CASE\s+WHEN\s+\d+\s*=\s*\d+/gi,
    category: 'BOOLEAN_BASED',
    weight: 70,
    description: "CASE WHEN condition test",
  },
];

// ============================================================================
// SQL Injection Detector Service
// ============================================================================

export class SQLInjectionDetector {
  private alerts: SQLInjectionAlert[] = [];
  private behavioralData: Map<string, BehavioralContext> = new Map();
  private recentDetections: Map<string, number> = new Map(); // hash -> count

  constructor() {
    // Start periodic cleanup
    this.startPeriodicCleanup();
  }

  /**
   * Analyze input for SQL injection attempts
   */
  analyze(
    input: string,
    context?: {
      sourceIp?: string;
      userId?: string;
      endpoint?: string;
    }
  ): SQLInjectionDetectionResult {
    const startTime = Date.now();

    // Normalize input for analysis
    const normalizedInput = this.normalizeInput(input);

    // Run pattern detection
    const detectedPatterns = this.detectPatterns(normalizedInput, input);

    // Calculate base risk score
    let riskScore = this.calculateRiskScore(detectedPatterns);

    // Apply behavioral analysis if context provided
    if (context?.sourceIp) {
      riskScore = this.applyBehavioralAnalysis(
        riskScore,
        context.sourceIp,
        detectedPatterns
      );
    }

    // Determine severity and confidence
    const severity = this.determineSeverity(riskScore);
    const confidence = this.calculateConfidence(detectedPatterns, riskScore);
    const isInjection = riskScore >= 50 && confidence >= 0.6;

    // Create result
    const result: SQLInjectionDetectionResult = {
      isInjection,
      confidence,
      severity,
      detectedPatterns,
      riskScore,
      recommendation: this.generateRecommendation(severity, detectedPatterns),
      metadata: {
        inputLength: input.length,
        normalizedInput: normalizedInput.substring(0, 100),
        analysisTime: Date.now() - startTime,
      },
    };

    // Log detection if injection found
    if (isInjection) {
      this.logDetection(input, result, context);
    }

    return result;
  }

  /**
   * Normalize input for consistent analysis
   */
  private normalizeInput(input: string): string {
    return input
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .trim();
  }

  /**
   * Detect patterns in input
   */
  private detectPatterns(
    normalizedInput: string,
    originalInput: string
  ): DetectedPattern[] {
    const detected: DetectedPattern[] = [];

    for (const patternDef of INJECTION_PATTERNS) {
      // Reset regex lastIndex
      patternDef.pattern.lastIndex = 0;

      let match;
      while ((match = patternDef.pattern.exec(normalizedInput)) !== null) {
        detected.push({
          pattern: patternDef.description,
          category: patternDef.category,
          matchedText: match[0],
          position: match.index,
          weight: patternDef.weight,
        });

        // Avoid infinite loops with zero-length matches
        if (match.index === patternDef.pattern.lastIndex) {
          patternDef.pattern.lastIndex++;
        }
      }
    }

    // Additional checks on original input
    detected.push(...this.checkStructuralAnomalies(originalInput));

    return detected;
  }

  /**
   * Check for structural anomalies that might indicate injection
   */
  private checkStructuralAnomalies(input: string): DetectedPattern[] {
    const anomalies: DetectedPattern[] = [];

    // Check for excessive quotes
    const quoteCount = (input.match(/['"`]/g) || []).length;
    if (quoteCount > 5) {
      anomalies.push({
        pattern: 'Excessive quote characters',
        category: 'CLASSIC_INJECTION',
        matchedText: `${quoteCount} quotes found`,
        position: 0,
        weight: Math.min(quoteCount * 5, 40),
      });
    }

    // Check for nested parentheses (common in injection)
    const parenDepth = this.maxParenthesesDepth(input);
    if (parenDepth > 3) {
      anomalies.push({
        pattern: 'Deeply nested parentheses',
        category: 'FUNCTION_ABUSE',
        matchedText: `Depth: ${parenDepth}`,
        position: 0,
        weight: parenDepth * 10,
      });
    }

    // Check for suspicious character sequences
    if (/['"]\s*[;+]\s*['"]/g.test(input)) {
      anomalies.push({
        pattern: 'String concatenation pattern',
        category: 'CLASSIC_INJECTION',
        matchedText: 'String concat detected',
        position: 0,
        weight: 50,
      });
    }

    return anomalies;
  }

  /**
   * Calculate maximum parentheses depth
   */
  private maxParenthesesDepth(input: string): number {
    let maxDepth = 0;
    let currentDepth = 0;

    for (const char of input) {
      if (char === '(') {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      } else if (char === ')') {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }

    return maxDepth;
  }

  /**
   * Calculate risk score from detected patterns
   */
  private calculateRiskScore(patterns: DetectedPattern[]): number {
    if (patterns.length === 0) {
      return 0;
    }

    // Sum of weighted patterns, with diminishing returns for duplicates
    const categoryWeights = new Map<string, number>();
    let totalScore = 0;

    for (const pattern of patterns) {
      const existingWeight = categoryWeights.get(pattern.category) || 0;
      // Diminishing returns for same category
      const adjustedWeight = pattern.weight * Math.pow(0.8, existingWeight);
      categoryWeights.set(pattern.category, existingWeight + 1);
      totalScore += adjustedWeight;
    }

    // Cap at 100
    return Math.min(100, totalScore);
  }

  /**
   * Apply behavioral analysis to risk score
   */
  private applyBehavioralAnalysis(
    baseScore: number,
    sourceIp: string,
    patterns: DetectedPattern[]
  ): number {
    let context = this.behavioralData.get(sourceIp);

    if (!context) {
      context = {
        sourceIp,
        recentAttempts: 0,
        uniquePatternCount: 0,
        lastAttemptTime: new Date(),
        blockedCount: 0,
      };
      this.behavioralData.set(sourceIp, context);
    }

    let adjustedScore = baseScore;

    // Increase score for repeat offenders
    if (context.recentAttempts > 3) {
      adjustedScore *= 1 + context.recentAttempts * 0.1;
    }

    // Increase score if previously blocked
    if (context.blockedCount > 0) {
      adjustedScore *= 1.5;
    }

    // Update behavioral data if this looks like an attempt
    if (baseScore >= 30) {
      context.recentAttempts++;
      context.lastAttemptTime = new Date();

      // Track unique patterns
      const patternHash = patterns.map((p) => p.category).sort().join(',');
      if (!this.recentDetections.has(patternHash)) {
        context.uniquePatternCount++;
      }
    }

    return Math.min(100, adjustedScore);
  }

  /**
   * Determine severity from risk score
   */
  private determineSeverity(
    riskScore: number
  ): SQLInjectionDetectionResult['severity'] {
    if (riskScore >= 90) return 'critical';
    if (riskScore >= 70) return 'high';
    if (riskScore >= 50) return 'medium';
    if (riskScore >= 30) return 'low';
    return 'none';
  }

  /**
   * Calculate confidence level
   */
  private calculateConfidence(
    patterns: DetectedPattern[],
    riskScore: number
  ): number {
    if (patterns.length === 0) {
      return 0;
    }

    // Higher confidence with more diverse pattern categories
    const uniqueCategories = new Set(patterns.map((p) => p.category)).size;
    const categoryDiversity = Math.min(uniqueCategories / 5, 1);

    // Higher confidence with higher weight patterns
    const avgWeight =
      patterns.reduce((sum, p) => sum + p.weight, 0) / patterns.length;
    const weightConfidence = avgWeight / 100;

    // Combine factors
    return (
      categoryDiversity * 0.4 +
      weightConfidence * 0.4 +
      (riskScore / 100) * 0.2
    );
  }

  /**
   * Generate recommendation based on detection
   */
  private generateRecommendation(
    severity: SQLInjectionDetectionResult['severity'],
    patterns: DetectedPattern[]
  ): string {
    if (severity === 'none') {
      return 'No action required';
    }

    const recommendations: string[] = [];

    if (severity === 'critical' || severity === 'high') {
      recommendations.push('Block request immediately');
      recommendations.push('Log IP address for monitoring');
    }

    if (patterns.some((p) => p.category === 'STACKED_QUERIES')) {
      recommendations.push('Review for data modification attempts');
    }

    if (patterns.some((p) => p.category === 'METADATA_ACCESS')) {
      recommendations.push('Check for schema enumeration attempts');
    }

    if (patterns.some((p) => p.category === 'TIME_BASED')) {
      recommendations.push('Monitor for timing-based blind injection');
    }

    if (severity === 'medium' || severity === 'low') {
      recommendations.push('Log for analysis');
      recommendations.push('Consider additional validation');
    }

    return recommendations.join('; ');
  }

  /**
   * Log detection and create alert
   */
  private logDetection(
    input: string,
    result: SQLInjectionDetectionResult,
    context?: {
      sourceIp?: string;
      userId?: string;
      endpoint?: string;
    }
  ): void {
    const alert: SQLInjectionAlert = {
      id: this.generateId(),
      type: 'sql_injection_attempt',
      severity: result.severity === 'none' ? 'low' : result.severity,
      source: 'sql_injection_detector',
      timestamp: new Date(),
      details: {
        input: input.substring(0, 500),
        detectedPatterns: result.detectedPatterns,
        confidence: result.confidence,
        riskScore: result.riskScore,
        sourceIp: context?.sourceIp,
        userId: context?.userId,
        endpoint: context?.endpoint,
      },
      resolved: false,
    };

    this.alerts.push(alert);

    // Limit alerts in memory
    if (this.alerts.length > 10000) {
      this.alerts = this.alerts.slice(-5000);
    }

    // Log to structured logger
    securityLogger.warn('SQL injection attempt detected', {
      module: 'SQLInjectionDetector',
      severity: result.severity,
      riskScore: result.riskScore,
      patterns: result.detectedPatterns.map((p) => p.pattern).join(', '),
      sourceIp: context?.sourceIp,
      userId: context?.userId,
      endpoint: context?.endpoint,
    });

    // Update behavioral data if we have IP
    if (context?.sourceIp) {
      const behaviorCtx = this.behavioralData.get(context.sourceIp);
      if (behaviorCtx && result.riskScore >= 70) {
        behaviorCtx.blockedCount++;
      }
    }
  }

  /**
   * Get recent alerts
   */
  getAlerts(limit: number = 100): SQLInjectionAlert[] {
    return this.alerts.slice(-limit);
  }

  /**
   * Get alerts by severity
   */
  getAlertsBySeverity(severity: SQLInjectionAlert['severity']): SQLInjectionAlert[] {
    return this.alerts.filter((a) => a.severity === severity);
  }

  /**
   * Get behavioral data for an IP
   */
  getBehavioralData(sourceIp: string): BehavioralContext | undefined {
    return this.behavioralData.get(sourceIp);
  }

  /**
   * Get high-risk IPs
   */
  getHighRiskIPs(): BehavioralContext[] {
    return Array.from(this.behavioralData.values())
      .filter((ctx) => ctx.blockedCount > 0 || ctx.recentAttempts > 5)
      .sort((a, b) => b.blockedCount - a.blockedCount);
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `sqli-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Start periodic cleanup
   */
  private startPeriodicCleanup(): void {
    // Clean old behavioral data every hour
    setInterval(() => {
      const oneHourAgo = Date.now() - 60 * 60 * 1000;

      for (const [ip, ctx] of this.behavioralData.entries()) {
        if (ctx.lastAttemptTime.getTime() < oneHourAgo && ctx.blockedCount === 0) {
          this.behavioralData.delete(ip);
        }
      }
    }, 3600000);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let instance: SQLInjectionDetector | null = null;

export function getSQLInjectionDetector(): SQLInjectionDetector {
  if (!instance) {
    instance = new SQLInjectionDetector();
  }
  return instance;
}

// ============================================================================
// Export
// ============================================================================

export default {
  SQLInjectionDetector,
  getSQLInjectionDetector,
  INJECTION_PATTERNS,
};
