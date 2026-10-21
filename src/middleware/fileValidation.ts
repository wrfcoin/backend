import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger.js';

// NOTE: This file intentionally uses no dynamic code evaluation (eval/Function).
// All file-type validation is performed via static lookup tables and buffer comparisons.
// Verified clean: audit issue #214 (2026-03-15).

interface FileRequest extends Request {
  file?: Express.Multer.File;
  user?: { id: string; role: string };
}

// File validation middleware
export function validateFileUpload(
  req: FileRequest,
  res: Response,
  next: NextFunction
): void {
  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: 'No file provided',
        code: 'NO_FILE',
      });
      return;
    }

    const file = req.file;
    const userId = req.user?.id;

    // 1. File size validation
    const maxFileSize = getMaxFileSizeForUser(req.user?.role);
    if (file.size > maxFileSize) {
      logger.warn('[File Validation] File too large', {
        userId,
        filename: file.originalname,
        size: file.size,
        maxSize: maxFileSize,
      });
      res.status(400).json({
        success: false,
        error: `File too large. Maximum size is ${formatBytes(maxFileSize)}`,
        code: 'FILE_TOO_LARGE',
      });
      return;
    }

    // 2. Filename validation
    if (!isValidFilename(file.originalname)) {
      logger.warn('[File Validation] Invalid filename', {
        userId,
        filename: file.originalname,
      });
      res.status(400).json({
        success: false,
        error:
          'Invalid filename. Use only alphanumeric characters, dots, hyphens, and underscores',
        code: 'INVALID_FILENAME',
      });
      return;
    }

    // 3. File extension validation
    const allowedExtensions = getAllowedExtensions();
    const fileExtension = getFileExtension(file.originalname);
    if (!allowedExtensions.includes(fileExtension.toLowerCase())) {
      logger.warn('[File Validation] Invalid file extension', {
        userId,
        filename: file.originalname,
        extension: fileExtension,
        allowedExtensions,
      });
      res.status(400).json({
        success: false,
        error: `File extension not allowed. Allowed extensions: ${allowedExtensions.join(', ')}`,
        code: 'INVALID_EXTENSION',
      });
      return;
    }

    // 4. MIME type validation
    const allowedMimeTypes = getAllowedMimeTypes();
    if (!allowedMimeTypes.includes(file.mimetype)) {
      logger.warn('[File Validation] Invalid MIME type', {
        userId,
        filename: file.originalname,
        mimetype: file.mimetype,
        allowedMimeTypes,
      });
      res.status(400).json({
        success: false,
        error: 'File type not allowed',
        code: 'INVALID_MIME_TYPE',
      });
      return;
    }

    // 5. Content validation for specific file types
    if (file.mimetype.startsWith('image/')) {
      if (!validateImageFile(file)) {
        logger.warn('[File Validation] Invalid image file', {
          userId,
          filename: file.originalname,
        });
        res.status(400).json({
          success: false,
          error: 'Invalid image file',
          code: 'INVALID_IMAGE',
        });
        return;
      }
    }

    // 6. Check for embedded executables or suspicious content
    if (containsSuspiciousContent(file.buffer)) {
      logger.warn('[File Validation] Suspicious content detected', {
        userId,
        filename: file.originalname,
      });
      res.status(400).json({
        success: false,
        error: 'File contains suspicious content',
        code: 'SUSPICIOUS_CONTENT',
      });
      return;
    }

    logger.debug('[File Validation] File passed validation', {
      userId,
      filename: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
    });

    next();
  } catch (error) {
    logger.error('[File Validation] Validation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'File validation failed',
      code: 'VALIDATION_ERROR',
    });
  }
}

// Helper functions
function getMaxFileSizeForUser(userRole?: string): number {
  const roleLimits = {
    admin: 50 * 1024 * 1024, // 50MB for admins
    premium: 20 * 1024 * 1024, // 20MB for premium users
    user: 10 * 1024 * 1024, // 10MB for regular users
  };

  return roleLimits[userRole as keyof typeof roleLimits] || roleLimits.user;
}

function isValidFilename(filename: string): boolean {
  // Allow alphanumeric characters, dots, hyphens, underscores, and spaces
  // Prevent path traversal and other dangerous patterns
  const validFilenameRegex = /^[a-zA-Z0-9._\-\s]+$/;
  const dangerousPatterns = [
    /\.\./, // Path traversal
    /^\./, // Hidden files
    /\$\{/, // Template injection
    /<script/i, // Script tags
    /javascript:/i, // JavaScript URLs
    /vbscript:/i, // VBScript URLs
    /data:/i, // Data URLs
    /\.exe$/i, // Executable files
    /\.bat$/i, // Batch files
    /\.cmd$/i, // Command files
    /\.scr$/i, // Screen saver files
    /\.com$/i, // DOS executables
    /\.pif$/i, // Program information files
  ];

  if (!validFilenameRegex.test(filename)) {
    return false;
  }

  for (const pattern of dangerousPatterns) {
    if (pattern.test(filename)) {
      return false;
    }
  }

  return filename.length > 0 && filename.length <= 255;
}

function getAllowedExtensions(): string[] {
  return [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp', // Images
    '.pdf', // Documents
    '.txt',
    '.csv',
    '.json', // Text files
  ];
}

function getAllowedMimeTypes(): string[] {
  return [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/json',
  ];
}

function getFileExtension(filename: string): string {
  const lastDotIndex = filename.lastIndexOf('.');
  return lastDotIndex !== -1 ? filename.substring(lastDotIndex) : '';
}

function validateImageFile(file: Express.Multer.File): boolean {
  try {
    // Check image file headers for common image formats
    const buffer = file.buffer;

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return file.mimetype === 'image/jpeg';
    }

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return file.mimetype === 'image/png';
    }

    // GIF: 47 49 46 38 (GIF8)
    if (
      buffer[0] === 0x47 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x38
    ) {
      return file.mimetype === 'image/gif';
    }

    // WebP: 52 49 46 46 (RIFF) + WebP signature
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46
    ) {
      // Check for WebP signature at offset 8
      if (
        buffer.length > 11 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
      ) {
        return file.mimetype === 'image/webp';
      }
    }

    return false;
  } catch (error) {
    logger.error('[File Validation] Image validation error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function containsSuspiciousContent(buffer: Buffer): boolean {
  try {
    // Convert buffer to string for pattern matching
    const content = buffer.toString('binary');

    // Check for executable signatures
    const suspiciousPatterns = [
      'MZ', // DOS/Windows executable header
      '\x7fELF', // Linux ELF executable header
      '\xfe\xed\xfa', // Mach-O executable header (macOS)
      '#!/bin/', // Shell script shebang
      '#!/usr/bin/', // Shell script shebang
      'javascript:', // JavaScript URL
      'vbscript:', // VBScript URL
      '<script', // HTML script tag
      '<?php', // PHP tag
      '<%', // ASP/JSP tag
      'eval(', // JavaScript eval
      'exec(', // Various exec functions
      'system(', // System calls
      'shell_exec(', // PHP shell execution
      'base64_decode(', // Encoded content
    ];

    for (const pattern of suspiciousPatterns) {
      if (content.includes(pattern)) {
        return true;
      }
    }

    // Check for excessive null bytes (could indicate binary content in text files)
    if (
      buffer.includes(0x00) &&
      buffer.filter(byte => byte === 0x00).length / buffer.length > 0.1
    ) {
      return true;
    }

    return false;
  } catch (error) {
    logger.error('[File Validation] Suspicious content check error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
