import winston from 'winston';

// Define log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Define colors for each level
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

winston.addColors(colors);

// Create the logger format
const format = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:ms' }),
  winston.format.colorize({ all: true }),
  winston.format.printf(
    info => `${info.timestamp} ${info.level}: ${info.message}`
  )
);

// Define which logs to be shown when we are in development
const level = () => {
  const env = process.env.NODE_ENV || 'development';
  const isDevelopment = env === 'development';
  return isDevelopment ? 'debug' : 'warn';
};

// Create the logger with custom configuration
const logger = winston.createLogger({
  level: level(),
  levels,
  format,
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
    }),
    new winston.transports.File({
      filename: 'logs/all.log',
    }),
  ],
});

// Add HTTP request logging format
export const httpLogger = winston.createLogger({
  level: 'http',
  levels,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
    winston.format.printf(info => {
      return JSON.stringify({
        timestamp: info.timestamp,
        level: info.level,
        service: 'api-gateway',
        ...(typeof info.message === 'object'
          ? info.message
          : { message: info.message }),
      });
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(info => {
          const data =
            typeof info.message === 'string'
              ? JSON.parse(info.message)
              : info.message;
          return `🌐 ${data.method} ${data.url} ${data.status} - ${data.responseTime}ms`;
        })
      ),
    }),
    new winston.transports.File({
      filename: 'logs/http.log',
    }),
  ],
});

export class Logger {
  static info(message: string, meta?: any) {
    logger.info(message, meta);
  }

  static warn(message: string, meta?: any) {
    logger.warn(message, meta);
  }

  static error(message: string, error?: Error | any) {
    if (error instanceof Error) {
      logger.error(`${message}: ${error.message}`, {
        stack: error.stack,
        name: error.name,
      });
    } else {
      logger.error(message, error);
    }
  }

  static debug(message: string, meta?: any) {
    logger.debug(message, meta);
  }

  static http(data: {
    method: string;
    url: string;
    status: number;
    responseTime: number;
    userAgent?: string;
    ip?: string;
    userId?: string;
  }) {
    httpLogger.http('', data);
  }

  static security(event: string, details: Record<string, any>) {
    logger.warn(`SECURITY: ${event}`, {
      timestamp: new Date().toISOString(),
      event,
      ...details,
    });
  }

  static performance(
    operation: string,
    duration: number,
    metadata?: Record<string, any>
  ) {
    logger.info(`PERFORMANCE: ${operation} completed in ${duration}ms`, {
      operation,
      duration,
      ...(metadata || {}),
    });
  }

  static auth(event: string, userAddress?: string, success: boolean = true) {
    const level = success ? 'info' : 'warn';
    logger.log(level, `AUTH: ${event}`, {
      userAddress,
      success,
      timestamp: new Date().toISOString(),
    });
  }

  static service(
    serviceName: string,
    event: string,
    status: 'healthy' | 'degraded' | 'down'
  ) {
    const level = status === 'healthy' ? 'info' : 'warn';
    logger.log(level, `SERVICE: ${serviceName} - ${event}`, {
      service: serviceName,
      status,
      timestamp: new Date().toISOString(),
    });
  }
}

export default logger;
