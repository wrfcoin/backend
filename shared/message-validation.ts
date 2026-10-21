/**
 * Comprehensive Message Validation
 * Schema-based validation, input sanitization, type validation
 *
 * SECURITY: Defense in depth message validation:
 * - Schema-based message validation
 * - Input sanitization and bounds checking
 * - Message type validation
 * - Protocol version compatibility checks
 */

import { EventEmitter } from 'events';
import DOMPurify from 'isomorphic-dompurify';

export interface MessageSchema {
  type: string;
  version: string;
  fields: Record<string, FieldSchema>;
  maxSize?: number;
}

export interface FieldSchema {
  type: 'string' | 'number' | 'boolean' | 'buffer' | 'object' | 'array';
  required: boolean;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  pattern?: RegExp;
  enum?: any[];
}

export class MessageValidator extends EventEmitter {
  private schemas: Map<string, MessageSchema> = new Map();
  private supportedVersions: Set<string> = new Set(['1.0', '2.0']);

  registerSchema(schema: MessageSchema): void {
    this.schemas.set(`${schema.type}:${schema.version}`, schema);
  }

  validate(message: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const schema = this.schemas.get(`${message.type}:${message.version}`);

    if (!schema) {
      errors.push(
        `Unknown message type/version: ${message.type}/${message.version}`
      );
      return { valid: false, errors };
    }

    if (!this.supportedVersions.has(message.version)) {
      errors.push(`Unsupported version: ${message.version}`);
    }

    for (const [field, fieldSchema] of Object.entries(schema.fields)) {
      const value = message[field];

      if (fieldSchema.required && value === undefined) {
        errors.push(`Missing required field: ${field}`);
        continue;
      }

      if (value !== undefined) {
        if (typeof value !== fieldSchema.type) {
          errors.push(
            `Invalid type for ${field}: expected ${fieldSchema.type}`
          );
        }

        if (fieldSchema.type === 'string') {
          if (fieldSchema.minLength && value.length < fieldSchema.minLength) {
            errors.push(`${field} too short (min: ${fieldSchema.minLength})`);
          }
          if (fieldSchema.maxLength && value.length > fieldSchema.maxLength) {
            errors.push(`${field} too long (max: ${fieldSchema.maxLength})`);
          }
          if (fieldSchema.pattern && !fieldSchema.pattern.test(value)) {
            errors.push(`${field} does not match pattern`);
          }
        }

        if (fieldSchema.type === 'number') {
          if (fieldSchema.min !== undefined && value < fieldSchema.min) {
            errors.push(`${field} below minimum (min: ${fieldSchema.min})`);
          }
          if (fieldSchema.max !== undefined && value > fieldSchema.max) {
            errors.push(`${field} above maximum (max: ${fieldSchema.max})`);
          }
        }

        if (fieldSchema.enum && !fieldSchema.enum.includes(value)) {
          errors.push(`${field} not in allowed values`);
        }
      }
    }

    const valid = errors.length === 0;
    this.emit(valid ? 'validationSuccess' : 'validationFailed', {
      type: message.type,
      errors,
    });

    return { valid, errors };
  }

  sanitizeString(input: string): string {
    return DOMPurify.sanitize(input, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] });
  }
}
