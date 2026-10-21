#!/usr/bin/env ts-node

/**
 * Task 67 Performance Benchmark Runner
 * Automated performance testing for API & backend integration optimization
 */

import {
  Task67PerformanceBenchmarker,
  TASK67_BENCHMARK_SCENARIOS,
} from './task67-performance-benchmarker.js';
import { serviceClientManager } from '../graphql/services/service-registry.js';
import { logger } from '../utils/logger.js';
import { promises as fs } from 'fs';
import path from 'path';

interface BenchmarkRunOptions {
  scenarios?: string[];
  outputFormat?: 'json' | 'markdown' | 'html';
  generateCharts?: boolean;
  compareWithBaseline?: boolean;
  baselinePath?: string;
  reportDirectory?: string;
}

class Task67BenchmarkRunner {
  private benchmarker: Task67PerformanceBenchmarker;
  private startTime: number = 0;

  constructor() {
    this.benchmarker = new Task67PerformanceBenchmarker();
  }

  async run(options: BenchmarkRunOptions = {}): Promise<void> {
    const {
      scenarios = [],
      outputFormat = 'json',
      generateCharts = true,
      compareWithBaseline = false,
      baselinePath,
      reportDirectory = 'performance/reports',
    } = options;

    logger.info('Starting Task 67 Performance Benchmark Suite', {
      scenarios: scenarios.length > 0 ? scenarios : 'all',
      outputFormat,
      generateCharts,
      compareWithBaseline,
    });

    this.startTime = Date.now();

    try {
      // 1. Pre-flight checks
      await this.runPreflightChecks();

      // 2. Select scenarios to run
      const scenariosToRun = this.selectScenarios(scenarios);

      // 3. Run benchmarks
      const results =
        await this.benchmarker.runComprehensiveBenchmark(scenariosToRun);

      // 4. Generate reports
      const reportPath = await this.generateReports(
        results,
        outputFormat,
        reportDirectory
      );

      // 5. Generate charts if requested
      if (generateCharts) {
        await this.generatePerformanceCharts(results, reportDirectory);
      }

      // 6. Compare with baseline if requested
      if (compareWithBaseline && baselinePath) {
        await this.compareWithBaseline(results, baselinePath, reportDirectory);
      }

      // 7. Validate performance targets
      const validation = await this.validatePerformanceTargets(results);

      // 8. Generate summary
      await this.generateExecutionSummary(results, validation, reportDirectory);

      const totalDuration = Date.now() - this.startTime;
      logger.info('Task 67 Performance Benchmark Suite completed', {
        duration: `${totalDuration / 1000}s`,
        reportPath,
        scenariosRun: results.length,
        performanceGrades: this.summarizeGrades(results),
      });
    } catch (error) {
      logger.error('Benchmark suite failed', {
        error: error instanceof Error ? error.message : String(error),
        duration: `${(Date.now() - this.startTime) / 1000}s`,
      });
      throw error;
    }
  }

  private async runPreflightChecks(): Promise<void> {
    logger.info('Running pre-flight checks...');

    // Check service health
    const healthStatus = await serviceClientManager.checkAllServices();
    const unhealthyServices = Object.entries(healthStatus)
      .filter(([_, healthy]) => !healthy)
      .map(([service]) => service);

    if (unhealthyServices.length > 0) {
      logger.warn('Some services are unhealthy', {
        unhealthyServices,
        totalServices: Object.keys(healthStatus).length,
      });
    }

    // Check system resources
    const memoryUsage = process.memoryUsage();
    const freeMemory =
      process.memoryUsage().heapTotal - process.memoryUsage().heapUsed;

    if (freeMemory < 500 * 1024 * 1024) {
      // Less than 500MB free
      logger.warn('Low memory available for benchmarks', {
        freeMemoryMB: Math.round(freeMemory / 1024 / 1024),
        recommendedMinimumMB: 500,
      });
    }

    // Check if performance reports directory exists
    const reportDir = path.join(process.cwd(), 'performance', 'reports');
    await fs.mkdir(reportDir, { recursive: true });

    logger.info('Pre-flight checks completed', {
      healthyServices:
        Object.keys(healthStatus).length - unhealthyServices.length,
      totalServices: Object.keys(healthStatus).length,
      freeMemoryMB: Math.round(freeMemory / 1024 / 1024),
    });
  }

  private selectScenarios(scenarioNames: string[]) {
    if (scenarioNames.length === 0) {
      return TASK67_BENCHMARK_SCENARIOS;
    }

    const selectedScenarios = TASK67_BENCHMARK_SCENARIOS.filter(scenario =>
      scenarioNames.includes(scenario.name)
    );

    if (selectedScenarios.length === 0) {
      throw new Error(
        `No scenarios found matching: ${scenarioNames.join(', ')}`
      );
    }

    logger.info('Selected scenarios for benchmarking', {
      selected: selectedScenarios.map(s => s.name),
      total: TASK67_BENCHMARK_SCENARIOS.length,
    });

    return selectedScenarios;
  }

  private async generateReports(
    results: any[],
    format: string,
    reportDirectory: string
  ): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseFilename = `task67-benchmark-${timestamp}`;

    switch (format) {
      case 'json':
        return await this.generateJSONReport(
          results,
          reportDirectory,
          baseFilename
        );
      case 'markdown':
        return await this.generateMarkdownReport(
          results,
          reportDirectory,
          baseFilename
        );
      case 'html':
        return await this.generateHTMLReport(
          results,
          reportDirectory,
          baseFilename
        );
      default:
        throw new Error(`Unsupported output format: ${format}`);
    }
  }

  private async generateJSONReport(
    results: any[],
    reportDirectory: string,
    baseFilename: string
  ): Promise<string> {
    const reportPath = path.join(reportDirectory, `${baseFilename}.json`);

    const report = {
      metadata: {
        generatedAt: new Date().toISOString(),
        version: '1.0.0',
        task: 'Task 67 - API & Backend Integration Performance',
        totalDuration: Date.now() - this.startTime,
        nodeVersion: process.version,
        platform: process.platform,
      },
      summary: this.generateDetailedSummary(results),
      results,
      recommendations: this.generateConsolidatedRecommendations(results),
      performanceTargets: {
        avgLatency: { target: 200, unit: 'ms' },
        p95Latency: { target: 500, unit: 'ms' },
        p99Latency: { target: 1000, unit: 'ms' },
        throughput: { target: 1000, unit: 'req/s' },
        errorRate: { target: 1, unit: '%' },
        cacheHitRate: { target: 80, unit: '%' },
      },
    };

    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    logger.info(`JSON report generated: ${reportPath}`);
    return reportPath;
  }

  private async generateMarkdownReport(
    results: any[],
    reportDirectory: string,
    baseFilename: string
  ): Promise<string> {
    const reportPath = path.join(reportDirectory, `${baseFilename}.md`);

    const summary = this.generateDetailedSummary(results);
    const recommendations = this.generateConsolidatedRecommendations(results);

    const markdown = `# Task 67 Performance Benchmark Report

Generated: ${new Date().toISOString()}
Duration: ${((Date.now() - this.startTime) / 1000).toFixed(2)}s

## Executive Summary

${this.generateExecutiveSummaryMarkdown(summary)}

## Performance Overview

### Latency Metrics
- **Average Latency**: ${summary.averageLatency?.toFixed(2) || 'N/A'}ms
- **P95 Latency**: ${summary.p95Latency?.toFixed(2) || 'N/A'}ms  
- **P99 Latency**: ${summary.p99Latency?.toFixed(2) || 'N/A'}ms

### Throughput Metrics
- **Average Throughput**: ${summary.averageThroughput?.toFixed(2) || 'N/A'} req/s
- **Peak Throughput**: ${summary.peakThroughput?.toFixed(2) || 'N/A'} req/s
- **Error Rate**: ${((summary.averageErrorRate || 0) * 100).toFixed(2)}%

### Performance Grades
${Object.entries(summary.gradeDistribution || {})
  .map(([grade, count]) => `- **${grade}**: ${count} scenario(s)`)
  .join('\n')}

## Detailed Results

${results.map(result => this.generateScenarioMarkdown(result)).join('\n\n')}

## Bottlenecks Analysis

${this.generateBottlenecksMarkdown(results)}

## Recommendations

${recommendations.map((rec, index) => `${index + 1}. ${rec}`).join('\n')}

## Service Performance Summary

${this.generateServicePerformanceMarkdown(results)}

## GraphQL Operations Performance

${this.generateGraphQLPerformanceMarkdown(results)}

---
*Generated by Task 67 Performance Benchmarker*
`;

    await fs.writeFile(reportPath, markdown);
    logger.info(`Markdown report generated: ${reportPath}`);
    return reportPath;
  }

  private async generateHTMLReport(
    results: any[],
    reportDirectory: string,
    baseFilename: string
  ): Promise<string> {
    const reportPath = path.join(reportDirectory, `${baseFilename}.html`);

    const summary = this.generateDetailedSummary(results);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Task 67 Performance Benchmark Report</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; margin-bottom: 30px; }
        .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin: 30px 0; }
        .metric-card { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 20px; }
        .metric-value { font-size: 2em; font-weight: bold; color: #495057; }
        .metric-label { color: #6c757d; font-size: 0.9em; margin-top: 5px; }
        .grade-A { background: #d4edda; border-color: #c3e6cb; }
        .grade-B { background: #d1ecf1; border-color: #bee5eb; }
        .grade-C { background: #fff3cd; border-color: #ffeaa7; }
        .grade-D { background: #f8d7da; border-color: #f5c6cb; }
        .grade-F { background: #f8d7da; border-color: #f1b0b7; }
        .scenario-result { margin: 30px 0; padding: 25px; border: 1px solid #dee2e6; border-radius: 8px; }
        .bottleneck { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 10px 0; }
        .recommendation { background: #d1ecf1; border-left: 4px solid #17a2b8; padding: 15px; margin: 10px 0; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { border: 1px solid #dee2e6; padding: 12px; text-align: left; }
        th { background: #e9ecef; font-weight: 600; }
        .status-healthy { color: #28a745; }
        .status-unhealthy { color: #dc3545; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Task 67 Performance Benchmark Report</h1>
            <p>Generated: ${new Date().toISOString()}</p>
            <p>Duration: ${((Date.now() - this.startTime) / 1000).toFixed(2)}s</p>
        </div>

        <div class="metrics-grid">
            <div class="metric-card">
                <div class="metric-value">${summary.averageLatency?.toFixed(1) || 'N/A'}<span style="font-size: 0.5em;">ms</span></div>
                <div class="metric-label">Average Latency</div>
            </div>
            <div class="metric-card">
                <div class="metric-value">${summary.averageThroughput?.toFixed(0) || 'N/A'}<span style="font-size: 0.5em;">req/s</span></div>
                <div class="metric-label">Average Throughput</div>
            </div>
            <div class="metric-card">
                <div class="metric-value">${((summary.averageErrorRate || 0) * 100).toFixed(2)}<span style="font-size: 0.5em;">%</span></div>
                <div class="metric-label">Error Rate</div>
            </div>
            <div class="metric-card">
                <div class="metric-value">${results.length}</div>
                <div class="metric-label">Scenarios Tested</div>
            </div>
        </div>

        <h2>Scenario Results</h2>
        ${results.map(result => this.generateScenarioHTML(result)).join('')}

        <h2>Performance Recommendations</h2>
        ${this.generateConsolidatedRecommendations(results)
          .map(rec => `<div class="recommendation">${rec}</div>`)
          .join('')}

        <h2>Bottlenecks Identified</h2>
        ${this.extractAllBottlenecks(results)
          .map(bottleneck => `<div class="bottleneck">${bottleneck}</div>`)
          .join('')}
    </div>
</body>
</html>`;

    await fs.writeFile(reportPath, html);
    logger.info(`HTML report generated: ${reportPath}`);
    return reportPath;
  }

  private async generatePerformanceCharts(
    results: any[],
    reportDirectory: string
  ): Promise<void> {
    logger.info('Generating performance charts...');

    // For now, create a simple chart data JSON that could be used by frontend charts
    const chartData = {
      latencyTrends: results.map(result => ({
        scenario: result.scenario,
        mean: result.overall.latency.mean,
        p95: result.overall.latency.p95,
        p99: result.overall.latency.p99,
      })),
      throughputTrends: results.map(result => ({
        scenario: result.scenario,
        throughput: result.overall.throughput.requestsPerSecond,
        errorRate: result.overall.throughput.errorRate,
      })),
      servicePerformance: results.flatMap(result =>
        result.services.map((service: any) => ({
          scenario: result.scenario,
          service: service.serviceName,
          latency: service.latency.mean,
          throughput: service.throughput.requestsPerSecond,
          errorRate: service.throughput.errorRate,
        }))
      ),
      gradeDistribution: results.reduce(
        (acc, result) => {
          acc[result.performanceGrade] =
            (acc[result.performanceGrade] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      ),
    };

    const chartPath = path.join(reportDirectory, 'chart-data.json');
    await fs.writeFile(chartPath, JSON.stringify(chartData, null, 2));

    logger.info(`Chart data generated: ${chartPath}`);
  }

  private async compareWithBaseline(
    results: any[],
    baselinePath: string,
    reportDirectory: string
  ): Promise<void> {
    try {
      const baselineData = JSON.parse(await fs.readFile(baselinePath, 'utf-8'));

      const comparison = {
        generatedAt: new Date().toISOString(),
        baseline: {
          timestamp: baselineData.metadata?.generatedAt || 'Unknown',
          results: baselineData.results || [],
        },
        current: {
          timestamp: new Date().toISOString(),
          results,
        },
        analysis: this.analyzePerformanceChanges(
          baselineData.results || [],
          results
        ),
      };

      const comparisonPath = path.join(
        reportDirectory,
        'performance-comparison.json'
      );
      await fs.writeFile(comparisonPath, JSON.stringify(comparison, null, 2));

      logger.info(`Performance comparison generated: ${comparisonPath}`);
    } catch (error) {
      logger.error('Failed to compare with baseline', {
        baselinePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async validatePerformanceTargets(results: any[]) {
    const targets = {
      avgLatency: 200, // ms
      p95Latency: 500, // ms
      p99Latency: 1000, // ms
      throughput: 1000, // req/s
      errorRate: 0.01, // 1%
      cacheHitRate: 0.8, // 80%
    };

    const summary = this.generateDetailedSummary(results);

    const validation = {
      avgLatency: {
        target: targets.avgLatency,
        actual: summary.averageLatency || 0,
        passed: (summary.averageLatency || 0) <= targets.avgLatency,
      },
      p95Latency: {
        target: targets.p95Latency,
        actual: summary.p95Latency || 0,
        passed: (summary.p95Latency || 0) <= targets.p95Latency,
      },
      p99Latency: {
        target: targets.p99Latency,
        actual: summary.p99Latency || 0,
        passed: (summary.p99Latency || 0) <= targets.p99Latency,
      },
      throughput: {
        target: targets.throughput,
        actual: summary.averageThroughput || 0,
        passed: (summary.averageThroughput || 0) >= targets.throughput,
      },
      errorRate: {
        target: targets.errorRate,
        actual: summary.averageErrorRate || 0,
        passed: (summary.averageErrorRate || 0) <= targets.errorRate,
      },
    };

    const overallPassed = Object.values(validation).every(v => v.passed);

    logger.info('Performance target validation', {
      overallPassed,
      passedTargets: Object.entries(validation).filter(([_, v]) => v.passed)
        .length,
      totalTargets: Object.keys(validation).length,
    });

    return { ...validation, overallPassed };
  }

  private async generateExecutionSummary(
    results: any[],
    validation: any,
    reportDirectory: string
  ): Promise<void> {
    const summary = {
      execution: {
        startTime: new Date(this.startTime).toISOString(),
        endTime: new Date().toISOString(),
        duration: Date.now() - this.startTime,
        scenariosRun: results.length,
        totalOperations: results.reduce(
          (sum, r) => sum + (r.overall.throughput.totalRequests || 0),
          0
        ),
      },
      performance: this.generateDetailedSummary(results),
      validation,
      topBottlenecks: this.getTopBottlenecks(results, 5),
      topRecommendations: this.generateConsolidatedRecommendations(
        results
      ).slice(0, 10),
      serviceStatus: this.summarizeServiceHealth(results),
      nextSteps: this.generateNextSteps(validation, results),
    };

    const summaryPath = path.join(reportDirectory, 'execution-summary.json');
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

    logger.info(`Execution summary generated: ${summaryPath}`);
  }

  // Helper methods for report generation
  private generateDetailedSummary(results: any[]) {
    if (results.length === 0) return {};

    const allLatencies = results.map(r => r.overall.latency.mean);
    const allP95Latencies = results.map(r => r.overall.latency.p95);
    const allP99Latencies = results.map(r => r.overall.latency.p99);
    const allThroughputs = results.map(
      r => r.overall.throughput.requestsPerSecond
    );
    const allErrorRates = results.map(r => r.overall.throughput.errorRate);

    return {
      totalScenarios: results.length,
      averageLatency:
        allLatencies.reduce((sum, val) => sum + val, 0) / allLatencies.length,
      p95Latency:
        allP95Latencies.reduce((sum, val) => sum + val, 0) /
        allP95Latencies.length,
      p99Latency:
        allP99Latencies.reduce((sum, val) => sum + val, 0) /
        allP99Latencies.length,
      averageThroughput:
        allThroughputs.reduce((sum, val) => sum + val, 0) /
        allThroughputs.length,
      peakThroughput: Math.max(...allThroughputs),
      averageErrorRate:
        allErrorRates.reduce((sum, val) => sum + val, 0) / allErrorRates.length,
      gradeDistribution: results.reduce(
        (acc, r) => {
          acc[r.performanceGrade] = (acc[r.performanceGrade] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      ),
    };
  }

  private generateConsolidatedRecommendations(results: any[]): string[] {
    const allRecommendations = results.flatMap(r => r.recommendations);
    const frequency = allRecommendations.reduce(
      (acc, rec) => {
        acc[rec] = (acc[rec] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    return Object.entries(frequency)
      .sort(([, a], [, b]) => b - a)
      .map(([rec]) => rec)
      .slice(0, 15); // Top 15 recommendations
  }

  private generateExecutiveSummaryMarkdown(summary: any): string {
    const totalScenarios = summary.totalScenarios || 0;
    const gradeDistribution = summary.gradeDistribution || {};
    const goodGrades = (gradeDistribution.A || 0) + (gradeDistribution.B || 0);
    const passingRate =
      totalScenarios > 0
        ? ((goodGrades / totalScenarios) * 100).toFixed(1)
        : '0';

    return `**${passingRate}%** of scenarios achieved A or B performance grades (${goodGrades}/${totalScenarios}). 
Average latency: **${summary.averageLatency?.toFixed(2) || 'N/A'}ms**, 
Peak throughput: **${summary.peakThroughput?.toFixed(0) || 'N/A'} req/s**, 
Error rate: **${((summary.averageErrorRate || 0) * 100).toFixed(2)}%**.`;
  }

  private generateScenarioMarkdown(result: any): string {
    return `### ${result.scenario} (Grade: ${result.performanceGrade})

**Performance Metrics:**
- Latency: ${result.overall.latency.mean.toFixed(2)}ms avg, ${result.overall.latency.p95.toFixed(2)}ms p95
- Throughput: ${result.overall.throughput.requestsPerSecond.toFixed(2)} req/s
- Error Rate: ${(result.overall.throughput.errorRate * 100).toFixed(2)}%
- Concurrency: ${result.concurrency}

**Services Tested:** ${result.services.map((s: any) => s.serviceName).join(', ')}`;
  }

  private generateScenarioHTML(result: any): string {
    return `
        <div class="scenario-result grade-${result.performanceGrade}">
            <h3>${result.scenario} <span style="float: right;">Grade: ${result.performanceGrade}</span></h3>
            <div class="metrics-grid">
                <div class="metric-card">
                    <div class="metric-value">${result.overall.latency.mean.toFixed(1)}<span style="font-size: 0.5em;">ms</span></div>
                    <div class="metric-label">Avg Latency</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value">${result.overall.throughput.requestsPerSecond.toFixed(0)}<span style="font-size: 0.5em;">req/s</span></div>
                    <div class="metric-label">Throughput</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value">${(result.overall.throughput.errorRate * 100).toFixed(2)}<span style="font-size: 0.5em;">%</span></div>
                    <div class="metric-label">Error Rate</div>
                </div>
                <div class="metric-card">
                    <div class="metric-value">${result.concurrency}</div>
                    <div class="metric-label">Concurrency</div>
                </div>
            </div>
        </div>`;
  }

  private generateBottlenecksMarkdown(results: any[]): string {
    const allBottlenecks = results.flatMap(r => r.bottlenecks);
    const frequency = allBottlenecks.reduce(
      (acc, bottleneck) => {
        acc[bottleneck] = (acc[bottleneck] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    return Object.entries(frequency)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(
        ([bottleneck, count], index) =>
          `${index + 1}. **${bottleneck}** (${count} scenario${count > 1 ? 's' : ''})`
      )
      .join('\n');
  }

  private generateServicePerformanceMarkdown(results: any[]): string {
    const serviceStats = this.aggregateServiceStats(results);

    return Object.entries(serviceStats)
      .map(
        ([serviceName, stats]: [string, any]) =>
          `- **${serviceName}**: ${stats.avgLatency.toFixed(2)}ms avg latency, ${stats.avgThroughput.toFixed(2)} req/s, ${(stats.avgErrorRate * 100).toFixed(2)}% error rate`
      )
      .join('\n');
  }

  private generateGraphQLPerformanceMarkdown(results: any[]): string {
    const graphqlStats = this.aggregateGraphQLStats(results);

    return Object.entries(graphqlStats)
      .map(
        ([operationName, stats]: [string, any]) =>
          `- **${operationName}**: ${stats.avgLatency.toFixed(2)}ms avg latency, complexity: ${stats.avgComplexity.toFixed(1)}, cache hit rate: ${(stats.avgCacheHitRate * 100).toFixed(1)}%`
      )
      .join('\n');
  }

  private summarizeGrades(results: any[]): Record<string, number> {
    return results.reduce(
      (acc, result) => {
        acc[result.performanceGrade] = (acc[result.performanceGrade] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );
  }

  private extractAllBottlenecks(results: any[]): string[] {
    return [...new Set(results.flatMap(r => r.bottlenecks))];
  }

  private getTopBottlenecks(results: any[], count: number): string[] {
    const allBottlenecks = results.flatMap(r => r.bottlenecks);
    const frequency = allBottlenecks.reduce(
      (acc, bottleneck) => {
        acc[bottleneck] = (acc[bottleneck] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    return Object.entries(frequency)
      .sort(([, a], [, b]) => b - a)
      .slice(0, count)
      .map(([bottleneck]) => bottleneck);
  }

  private summarizeServiceHealth(results: any[]): Record<string, any> {
    const serviceHealth: Record<string, any> = {};

    results.forEach(result => {
      result.services.forEach((service: any) => {
        if (!serviceHealth[service.serviceName]) {
          serviceHealth[service.serviceName] = {
            totalTests: 0,
            healthyTests: 0,
            avgLatency: 0,
            avgErrorRate: 0,
          };
        }

        serviceHealth[service.serviceName].totalTests++;
        if (service.healthStatus) {
          serviceHealth[service.serviceName].healthyTests++;
        }
        serviceHealth[service.serviceName].avgLatency += service.latency.mean;
        serviceHealth[service.serviceName].avgErrorRate +=
          service.throughput.errorRate;
      });
    });

    // Calculate averages
    Object.values(serviceHealth).forEach((health: any) => {
      health.avgLatency /= health.totalTests;
      health.avgErrorRate /= health.totalTests;
      health.healthRate = health.healthyTests / health.totalTests;
    });

    return serviceHealth;
  }

  private generateNextSteps(validation: any, results: any[]): string[] {
    const nextSteps: string[] = [];

    if (!validation.overallPassed) {
      nextSteps.push('Address performance targets that are not being met');
    }

    const criticalBottlenecks = this.getTopBottlenecks(results, 3);
    if (criticalBottlenecks.length > 0) {
      nextSteps.push(
        `Focus on resolving critical bottlenecks: ${criticalBottlenecks.join(', ')}`
      );
    }

    const failingGrades = results.filter(r =>
      ['D', 'F'].includes(r.performanceGrade)
    );
    if (failingGrades.length > 0) {
      nextSteps.push(
        `Investigate scenarios with failing grades: ${failingGrades.map(r => r.scenario).join(', ')}`
      );
    }

    nextSteps.push('Implement continuous performance monitoring');
    nextSteps.push('Schedule regular performance regression testing');

    return nextSteps;
  }

  private analyzePerformanceChanges(baseline: any[], current: any[]): any {
    // Simple analysis comparing scenario performance
    const changes: any = {
      improved: [],
      degraded: [],
      new: [],
      removed: [],
    };

    const baselineMap = new Map(baseline.map(r => [r.scenario, r]));
    const currentMap = new Map(current.map(r => [r.scenario, r]));

    // Check for improvements and degradations
    current.forEach(currentResult => {
      const baselineResult = baselineMap.get(currentResult.scenario);
      if (baselineResult) {
        const latencyChange =
          currentResult.overall.latency.mean -
          baselineResult.overall.latency.mean;
        const throughputChange =
          currentResult.overall.throughput.requestsPerSecond -
          baselineResult.overall.throughput.requestsPerSecond;

        if (latencyChange < -10 || throughputChange > 50) {
          // Improved
          changes.improved.push({
            scenario: currentResult.scenario,
            latencyChange,
            throughputChange,
          });
        } else if (latencyChange > 10 || throughputChange < -50) {
          // Degraded
          changes.degraded.push({
            scenario: currentResult.scenario,
            latencyChange,
            throughputChange,
          });
        }
      } else {
        changes.new.push(currentResult.scenario);
      }
    });

    // Check for removed scenarios
    baseline.forEach(baselineResult => {
      if (!currentMap.has(baselineResult.scenario)) {
        changes.removed.push(baselineResult.scenario);
      }
    });

    return changes;
  }

  private aggregateServiceStats(results: any[]): Record<string, any> {
    const serviceStats: Record<string, any> = {};

    results.forEach(result => {
      result.services.forEach((service: any) => {
        if (!serviceStats[service.serviceName]) {
          serviceStats[service.serviceName] = {
            latencies: [],
            throughputs: [],
            errorRates: [],
          };
        }

        serviceStats[service.serviceName].latencies.push(service.latency.mean);
        serviceStats[service.serviceName].throughputs.push(
          service.throughput.requestsPerSecond
        );
        serviceStats[service.serviceName].errorRates.push(
          service.throughput.errorRate
        );
      });
    });

    // Calculate averages
    Object.entries(serviceStats).forEach(([serviceName, stats]) => {
      serviceStats[serviceName] = {
        avgLatency:
          stats.latencies.reduce((sum: number, val: number) => sum + val, 0) /
          stats.latencies.length,
        avgThroughput:
          stats.throughputs.reduce((sum: number, val: number) => sum + val, 0) /
          stats.throughputs.length,
        avgErrorRate:
          stats.errorRates.reduce((sum: number, val: number) => sum + val, 0) /
          stats.errorRates.length,
      };
    });

    return serviceStats;
  }

  private aggregateGraphQLStats(results: any[]): Record<string, any> {
    const graphqlStats: Record<string, any> = {};

    results.forEach(result => {
      result.graphql.forEach((operation: any) => {
        if (!graphqlStats[operation.operationName]) {
          graphqlStats[operation.operationName] = {
            latencies: [],
            complexities: [],
            cacheHitRates: [],
          };
        }

        graphqlStats[operation.operationName].latencies.push(
          operation.latency.mean
        );
        graphqlStats[operation.operationName].complexities.push(
          operation.complexity
        );
        graphqlStats[operation.operationName].cacheHitRates.push(
          operation.cacheHitRate
        );
      });
    });

    // Calculate averages
    Object.entries(graphqlStats).forEach(([operationName, stats]) => {
      graphqlStats[operationName] = {
        avgLatency:
          stats.latencies.reduce((sum: number, val: number) => sum + val, 0) /
          stats.latencies.length,
        avgComplexity:
          stats.complexities.reduce(
            (sum: number, val: number) => sum + val,
            0
          ) / stats.complexities.length,
        avgCacheHitRate:
          stats.cacheHitRates.reduce(
            (sum: number, val: number) => sum + val,
            0
          ) / stats.cacheHitRates.length,
      };
    });

    return graphqlStats;
  }
}

// CLI Interface
async function main() {
  const args = process.argv.slice(2);
  const options: BenchmarkRunOptions = {};

  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--scenarios':
        options.scenarios = args[++i]?.split(',') || [];
        break;
      case '--format':
        options.outputFormat = args[++i] as 'json' | 'markdown' | 'html';
        break;
      case '--charts':
        options.generateCharts = true;
        break;
      case '--baseline':
        options.compareWithBaseline = true;
        options.baselinePath = args[++i];
        break;
      case '--output-dir':
        options.reportDirectory = args[++i];
        break;
      case '--help':
        console.log(`
Task 67 Performance Benchmark Runner

Usage: npm run benchmark:task67 [options]

Options:
  --scenarios <names>     Run specific scenarios (comma-separated)
  --format <type>         Output format: json, markdown, html (default: json)
  --charts               Generate performance charts
  --baseline <path>      Compare with baseline results
  --output-dir <path>    Output directory for reports
  --help                 Show this help message

Examples:
  npm run benchmark:task67
  npm run benchmark:task67 -- --scenarios "Low Load Baseline,Medium Load Stress Test"
  npm run benchmark:task67 -- --format markdown --charts
  npm run benchmark:task67 -- --baseline reports/baseline.json --format html
        `);
        process.exit(0);
    }
  }

  const runner = new Task67BenchmarkRunner();

  try {
    await runner.run(options);
    process.exit(0);
  } catch (error) {
    console.error('Benchmark failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

export { Task67BenchmarkRunner };
