/**
 * File Upload Security Utilities
 *
 * Provides comprehensive file upload validation and sanitization for API endpoints.
 * Implements magic number validation, extension blocking, filename sanitization,
 * path traversal protection, and file size limits.
 *
 * @module file-upload-security
 */

import path from 'path';
import crypto from 'crypto';
import { Request, Response, NextFunction, RequestHandler } from 'express';

// ============================================================================
// Magic Number Signatures for File Type Detection
// ============================================================================

/**
 * Magic number signatures for common file types.
 * These are the byte sequences at the beginning of files that identify their type.
 */
const FILE_SIGNATURES: Record<string, Buffer[]> = {
  // Image formats
  'image/jpeg': [
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE1]),
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE2]),
    Buffer.from([0xFF, 0xD8, 0xFF, 0xE8]),
    Buffer.from([0xFF, 0xD8, 0xFF]),
  ],
  'image/png': [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
  'image/gif': [Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]), Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])],
  'image/webp': [Buffer.from([0x52, 0x49, 0x46, 0x46])], // RIFF header, requires additional WEBP check
  'image/bmp': [Buffer.from([0x42, 0x4D])],
  'image/tiff': [Buffer.from([0x49, 0x49, 0x2A, 0x00]), Buffer.from([0x4D, 0x4D, 0x00, 0x2A])],
  'image/svg+xml': [Buffer.from([0x3C, 0x73, 0x76, 0x67])], // <svg
  'image/x-icon': [Buffer.from([0x00, 0x00, 0x01, 0x00])],

  // Document formats
  'application/pdf': [Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D])], // %PDF-

  // Archive formats
  'application/zip': [Buffer.from([0x50, 0x4B, 0x03, 0x04]), Buffer.from([0x50, 0x4B, 0x05, 0x06])],
  'application/gzip': [Buffer.from([0x1F, 0x8B])],
  'application/x-tar': [Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72])], // "ustar" at offset 257
  'application/x-rar-compressed': [Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07])],
  'application/x-7z-compressed': [Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])],

  // Audio formats
  'audio/mpeg': [Buffer.from([0xFF, 0xFB]), Buffer.from([0xFF, 0xFA]), Buffer.from([0x49, 0x44, 0x33])],
  'audio/wav': [Buffer.from([0x52, 0x49, 0x46, 0x46])], // RIFF header
  'audio/ogg': [Buffer.from([0x4F, 0x67, 0x67, 0x53])],

  // Video formats
  'video/mp4': [
    Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
    Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]),
  ],
  'video/webm': [Buffer.from([0x1A, 0x45, 0xDF, 0xA3])],

  // Data formats
  'application/json': [Buffer.from([0x7B])], // {
  'text/xml': [Buffer.from([0x3C, 0x3F, 0x78, 0x6D, 0x6C])], // <?xml
  'text/csv': [], // No magic number, needs content analysis

  // Weather data formats (NetCDF, HDF5, GRIB)
  'application/x-netcdf': [Buffer.from([0x43, 0x44, 0x46, 0x01]), Buffer.from([0x43, 0x44, 0x46, 0x02])],
  'application/x-hdf': [Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0D, 0x0A, 0x1A, 0x0A])],
  'application/x-grib': [Buffer.from([0x47, 0x52, 0x49, 0x42])],
};

// ============================================================================
// Dangerous File Extensions
// ============================================================================

/**
 * Blocked file extensions that could be used for malicious purposes.
 * Includes executables, scripts, server-side code, and configuration files.
 */
const BLOCKED_EXTENSIONS: string[] = [
  // Executables
  '.exe', '.dll', '.so', '.dylib', '.com', '.msi', '.app', '.deb', '.rpm',

  // Scripts
  '.bat', '.cmd', '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.ws', '.wsf', '.wsc', '.wsh',

  // Server-side code
  '.php', '.php3', '.php4', '.php5', '.php7', '.phtml', '.phar',
  '.jsp', '.jspx', '.jsw', '.jsv', '.jspf',
  '.asp', '.aspx', '.asa', '.asax', '.ascx', '.ashx', '.asmx', '.cer',
  '.cgi', '.pl', '.pm', '.py', '.pyc', '.pyo', '.pyd', '.rb',

  // Configuration files
  '.htaccess', '.htpasswd', '.config', '.conf', '.ini', '.env',
  '.xml', '.yml', '.yaml', '.json', '.sql',

  // Java
  '.jar', '.war', '.ear', '.class',

  // Dangerous document formats
  '.hta', '.scr', '.pif', '.reg', '.lnk', '.url',

  // Template files
  '.ejs', '.pug', '.jade', '.twig', '.blade.php', '.erb', '.haml',

  // Other potentially dangerous
  '.swf', '.action', '.cfc', '.cfm',
];

/**
 * Additional patterns to block (case-insensitive)
 */
const BLOCKED_PATTERNS: RegExp[] = [
  /\.php\d*$/i,
  /\.asp[x]?$/i,
  /\.jsp[x]?$/i,
  /\.(exe|dll|so|dylib)$/i,
  /\.(bat|cmd|sh|ps1)$/i,
];

// ============================================================================
// File Size Limits
// ============================================================================

/**
 * Maximum file sizes by MIME type category (in bytes).
 */
const MAX_FILE_SIZES: Record<string, number> = {
  // Images
  'image/jpeg': 10 * 1024 * 1024,           // 10MB
  'image/png': 10 * 1024 * 1024,            // 10MB
  'image/gif': 5 * 1024 * 1024,             // 5MB
  'image/webp': 10 * 1024 * 1024,           // 10MB
  'image/svg+xml': 1 * 1024 * 1024,         // 1MB (SVG can contain scripts)
  'image/*': 10 * 1024 * 1024,              // 10MB default for images

  // Documents
  'application/pdf': 50 * 1024 * 1024,      // 50MB

  // Archives
  'application/zip': 100 * 1024 * 1024,     // 100MB
  'application/gzip': 100 * 1024 * 1024,    // 100MB

  // Audio
  'audio/*': 50 * 1024 * 1024,              // 50MB

  // Video
  'video/*': 500 * 1024 * 1024,             // 500MB

  // Weather data files
  'application/x-netcdf': 500 * 1024 * 1024, // 500MB
  'application/x-hdf': 500 * 1024 * 1024,    // 500MB
  'application/x-grib': 200 * 1024 * 1024,   // 200MB

  // Data files
  'text/csv': 50 * 1024 * 1024,             // 50MB
  'application/json': 10 * 1024 * 1024,     // 10MB

  // Default
  'default': 5 * 1024 * 1024,               // 5MB default
};

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Result of file validation.
 */
export interface FileValidationResult {
  /** Whether the file passed all validation checks */
  valid: boolean;
  /** Error message if validation failed */
  error?: string;
  /** Error code for programmatic handling */
  errorCode?: string;
  /** Sanitized filename (if validation passed) */
  sanitizedFilename?: string;
  /** Detected MIME type based on magic number */
  detectedMimeType?: string;
  /** Quality score (0-100) for the validation */
  qualityScore?: number;
}

/**
 * Options for file validation.
 */
export interface FileValidationOptions {
  /** Maximum file size override (in bytes) */
  maxSize?: number;
  /** Allowed MIME types (empty array = all allowed) */
  allowedTypes?: string[];
  /** Additional blocked extensions */
  additionalBlockedExtensions?: string[];
  /** Whether to require magic number validation */
  requireMagicValidation?: boolean;
  /** Whether to generate unique filenames */
  generateUniqueFilename?: boolean;
  /** Custom filename prefix */
  filenamePrefix?: string;
  /** Base directory for path safety checks */
  baseDirectory?: string;
}

/**
 * Multer-compatible file interface.
 */
export interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
  destination?: string;
  filename?: string;
  path?: string;
}

// ============================================================================
// Magic Number Validation
// ============================================================================

/**
 * Validates that a file's content matches its claimed MIME type by checking magic numbers.
 *
 * @param buffer - The file content buffer
 * @param claimedMimeType - The MIME type claimed by the upload
 * @returns true if the magic number matches the claimed type (or no signature exists)
 */
export function validateMagicNumber(buffer: Buffer, claimedMimeType: string): boolean {
  if (!buffer || buffer.length === 0) {
    return false;
  }

  const signatures = FILE_SIGNATURES[claimedMimeType];

  // If no signature is defined for this type, we can't validate
  if (!signatures || signatures.length === 0) {
    return true;
  }

  // Check if any signature matches
  return signatures.some(sig => {
    if (buffer.length < sig.length) {
      return false;
    }
    return buffer.slice(0, sig.length).equals(sig);
  });
}

/**
 * Detects the MIME type of a file based on its magic number.
 *
 * @param buffer - The file content buffer
 * @returns The detected MIME type or null if not recognized
 */
export function detectMimeType(buffer: Buffer): string | null {
  if (!buffer || buffer.length === 0) {
    return null;
  }

  for (const [mimeType, signatures] of Object.entries(FILE_SIGNATURES)) {
    if (signatures.length === 0) continue;

    const matches = signatures.some(sig => {
      if (buffer.length < sig.length) return false;
      return buffer.slice(0, sig.length).equals(sig);
    });

    if (matches) {
      return mimeType;
    }
  }

  return null;
}

// ============================================================================
// Extension Validation
// ============================================================================

/**
 * Checks if a file extension is blocked.
 *
 * @param filename - The filename to check
 * @param additionalBlocked - Additional extensions to block
 * @returns true if the extension is blocked
 */
export function isExtensionBlocked(
  filename: string,
  additionalBlocked: string[] = []
): boolean {
  if (!filename) return true;

  const ext = path.extname(filename).toLowerCase();

  // Check against blocked extensions list
  if (BLOCKED_EXTENSIONS.includes(ext)) {
    return true;
  }

  // Check additional blocked extensions
  if (additionalBlocked.includes(ext)) {
    return true;
  }

  // Check against blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(filename)) {
      return true;
    }
  }

  // Check for double extensions that might bypass filters
  const parts = filename.split('.');
  if (parts.length > 2) {
    // Check if any intermediate extension is blocked
    for (let i = 1; i < parts.length - 1; i++) {
      const intermediateExt = '.' + parts[i].toLowerCase();
      if (BLOCKED_EXTENSIONS.includes(intermediateExt)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Gets the safe extension from a filename.
 *
 * @param filename - The filename to process
 * @returns The extension or empty string if blocked
 */
export function getSafeExtension(filename: string): string {
  if (!filename) return '';

  const ext = path.extname(filename).toLowerCase();

  if (isExtensionBlocked(filename)) {
    return '';
  }

  return ext;
}

// ============================================================================
// Filename Sanitization
// ============================================================================

/**
 * Sanitizes a filename to prevent path traversal and other attacks.
 *
 * @param filename - The original filename
 * @param options - Sanitization options
 * @returns Sanitized and unique filename
 */
export function sanitizeFilename(
  filename: string,
  options: {
    generateUnique?: boolean;
    prefix?: string;
    maxLength?: number;
  } = {}
): string {
  const { generateUnique = true, prefix = '', maxLength = 255 } = options;

  if (!filename) {
    // Generate a completely random filename
    const randomName = crypto.randomBytes(16).toString('hex');
    return prefix ? `${prefix}_${randomName}` : randomName;
  }

  // Step 1: Remove path components (prevent path traversal)
  let sanitized = path.basename(filename);

  // Step 2: Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');
  sanitized = sanitized.replace(/%00/g, '');

  // Step 3: Remove dangerous characters
  // Keep only alphanumeric, dots, hyphens, underscores
  sanitized = sanitized.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');

  // Step 4: Remove leading/trailing dots and spaces
  sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, '');

  // Step 5: Collapse multiple underscores/dots
  sanitized = sanitized.replace(/_{2,}/g, '_');
  sanitized = sanitized.replace(/\.{2,}/g, '.');

  // Step 6: Handle empty result
  if (!sanitized || sanitized === '') {
    sanitized = 'unnamed_file';
  }

  // Step 7: Get extension and base name
  const ext = getSafeExtension(sanitized);
  let baseName = path.basename(sanitized, ext);

  // Step 8: Apply prefix if specified
  if (prefix) {
    baseName = `${prefix}_${baseName}`;
  }

  // Step 9: Generate unique identifier if requested
  if (generateUnique) {
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const timestamp = Date.now().toString(36);
    baseName = `${baseName}_${timestamp}_${uniqueId}`;
  }

  // Step 10: Truncate if too long
  const maxBaseLength = maxLength - ext.length;
  if (baseName.length > maxBaseLength) {
    baseName = baseName.slice(0, maxBaseLength);
  }

  // Step 11: Combine and return
  return baseName + ext;
}

// ============================================================================
// Path Traversal Protection
// ============================================================================

/**
 * Checks if a file path is safe within a base directory.
 * Prevents path traversal attacks.
 *
 * @param filepath - The file path to check
 * @param baseDir - The base directory that should contain the file
 * @returns true if the path is safe (within baseDir)
 */
export function isPathSafe(filepath: string, baseDir: string): boolean {
  if (!filepath || !baseDir) {
    return false;
  }

  // Resolve both paths to absolute paths
  const resolvedPath = path.resolve(baseDir, filepath);
  const resolvedBase = path.resolve(baseDir);

  // Ensure the resolved path starts with the base directory
  // Add path.sep to prevent matching partial directory names
  // e.g., /home/user vs /home/username
  return resolvedPath.startsWith(resolvedBase + path.sep) ||
         resolvedPath === resolvedBase;
}

/**
 * Normalizes a file path and removes dangerous sequences.
 *
 * @param filepath - The file path to normalize
 * @returns Normalized path with dangerous sequences removed
 */
export function normalizePath(filepath: string): string {
  if (!filepath) return '';

  // Remove null bytes
  let normalized = filepath.replace(/\0/g, '');

  // Remove URL encoding of dangerous sequences
  normalized = normalized.replace(/%2e/gi, '.');
  normalized = normalized.replace(/%2f/gi, '/');
  normalized = normalized.replace(/%5c/gi, '\\');

  // Remove path traversal sequences
  normalized = normalized.replace(/\.{2,}/g, '.');
  normalized = normalized.replace(/\/{2,}/g, '/');
  normalized = normalized.replace(/\\{2,}/g, '\\');

  // Use path.normalize to handle remaining edge cases
  normalized = path.normalize(normalized);

  // Remove leading slashes and backslashes for relative paths
  normalized = normalized.replace(/^[/\\]+/, '');

  return normalized;
}

/**
 * Creates a safe file path within a base directory.
 *
 * @param baseDir - The base directory
 * @param filename - The filename (will be sanitized)
 * @param subdirectory - Optional subdirectory within baseDir
 * @returns Safe absolute file path
 */
export function createSafeFilePath(
  baseDir: string,
  filename: string,
  subdirectory?: string
): string {
  // Sanitize the filename first
  const safeFilename = sanitizeFilename(filename);

  // Build the path
  let targetPath: string;
  if (subdirectory) {
    const safeSubdir = normalizePath(subdirectory);
    targetPath = path.join(baseDir, safeSubdir, safeFilename);
  } else {
    targetPath = path.join(baseDir, safeFilename);
  }

  // Verify the path is safe
  if (!isPathSafe(targetPath, baseDir)) {
    throw new Error('Path traversal attempt detected');
  }

  return targetPath;
}

// ============================================================================
// File Size Validation
// ============================================================================

/**
 * Gets the maximum allowed file size for a MIME type.
 *
 * @param mimeType - The MIME type of the file
 * @returns Maximum allowed size in bytes
 */
export function getMaxFileSize(mimeType: string): number {
  // Check for exact match
  if (MAX_FILE_SIZES[mimeType]) {
    return MAX_FILE_SIZES[mimeType];
  }

  // Check for category match (e.g., image/*, video/*)
  const category = mimeType.split('/')[0] + '/*';
  if (MAX_FILE_SIZES[category]) {
    return MAX_FILE_SIZES[category];
  }

  // Return default
  return MAX_FILE_SIZES['default'];
}

/**
 * Validates file size against limits.
 *
 * @param size - The file size in bytes
 * @param mimeType - The MIME type of the file
 * @param customMaxSize - Optional custom maximum size
 * @returns true if the file size is within limits
 */
export function validateFileSize(
  size: number,
  mimeType: string,
  customMaxSize?: number
): boolean {
  if (size <= 0) return false;

  const maxSize = customMaxSize ?? getMaxFileSize(mimeType);
  return size <= maxSize;
}

// ============================================================================
// Comprehensive File Validation
// ============================================================================

/**
 * Performs comprehensive validation on an uploaded file.
 *
 * @param buffer - The file content buffer
 * @param filename - The original filename
 * @param claimedMimeType - The MIME type claimed by the upload
 * @param options - Validation options
 * @returns Validation result with sanitized filename if valid
 */
export function validateFileUpload(
  buffer: Buffer,
  filename: string,
  claimedMimeType: string,
  options: FileValidationOptions = {}
): FileValidationResult {
  const {
    maxSize,
    allowedTypes = [],
    additionalBlockedExtensions = [],
    requireMagicValidation = true,
    generateUniqueFilename = true,
    filenamePrefix,
    baseDirectory,
  } = options;

  let qualityScore = 100;

  // 1. Check for empty buffer
  if (!buffer || buffer.length === 0) {
    return {
      valid: false,
      error: 'File is empty',
      errorCode: 'EMPTY_FILE',
      qualityScore: 0,
    };
  }

  // 2. Check extension
  if (isExtensionBlocked(filename, additionalBlockedExtensions)) {
    return {
      valid: false,
      error: 'File type not allowed',
      errorCode: 'BLOCKED_EXTENSION',
      qualityScore: 0,
    };
  }

  // 3. Check magic number (content-based type validation)
  if (requireMagicValidation) {
    const detectedType = detectMimeType(buffer);

    if (detectedType && detectedType !== claimedMimeType) {
      // Allow some flexibility for related types
      const claimedCategory = claimedMimeType.split('/')[0];
      const detectedCategory = detectedType.split('/')[0];

      if (claimedCategory !== detectedCategory) {
        return {
          valid: false,
          error: 'File content does not match declared type',
          errorCode: 'MIME_MISMATCH',
          detectedMimeType: detectedType,
          qualityScore: 0,
        };
      }

      // Reduce quality score for mismatched subtypes
      qualityScore -= 10;
    }

    if (!validateMagicNumber(buffer, claimedMimeType)) {
      const detectedType = detectMimeType(buffer);
      if (detectedType) {
        return {
          valid: false,
          error: 'File content does not match declared type',
          errorCode: 'MAGIC_NUMBER_MISMATCH',
          detectedMimeType: detectedType,
          qualityScore: 0,
        };
      }
      // If we can't detect the type and can't validate, reduce quality
      qualityScore -= 20;
    }
  }

  // 4. Check file size
  const effectiveMaxSize = maxSize ?? getMaxFileSize(claimedMimeType);
  if (buffer.length > effectiveMaxSize) {
    const sizeMB = (effectiveMaxSize / (1024 * 1024)).toFixed(1);
    return {
      valid: false,
      error: `File exceeds maximum size of ${sizeMB}MB`,
      errorCode: 'FILE_TOO_LARGE',
      qualityScore: 0,
    };
  }

  // 5. Check allowed types
  if (allowedTypes.length > 0) {
    const isAllowed = allowedTypes.some(type => {
      if (type === '*/*') return true;
      if (type.endsWith('/*')) {
        const category = type.slice(0, -2);
        return claimedMimeType.startsWith(category + '/');
      }
      return type === claimedMimeType;
    });

    if (!isAllowed) {
      return {
        valid: false,
        error: 'File type not allowed',
        errorCode: 'TYPE_NOT_ALLOWED',
        qualityScore: 0,
      };
    }
  }

  // 6. Sanitize filename
  const sanitizedFilename = sanitizeFilename(filename, {
    generateUnique: generateUniqueFilename,
    prefix: filenamePrefix,
  });

  // 7. Validate path safety if base directory is provided
  if (baseDirectory) {
    if (!isPathSafe(path.join(baseDirectory, sanitizedFilename), baseDirectory)) {
      return {
        valid: false,
        error: 'Invalid file path',
        errorCode: 'PATH_TRAVERSAL',
        qualityScore: 0,
      };
    }
  }

  // 8. Additional checks for specific file types
  if (claimedMimeType === 'image/svg+xml') {
    // SVG files can contain scripts - perform additional sanitization
    const content = buffer.toString('utf-8');
    if (containsDangerousSVGContent(content)) {
      return {
        valid: false,
        error: 'SVG file contains potentially dangerous content',
        errorCode: 'DANGEROUS_SVG',
        qualityScore: 0,
      };
    }
  }

  return {
    valid: true,
    sanitizedFilename,
    detectedMimeType: detectMimeType(buffer) ?? claimedMimeType,
    qualityScore,
  };
}

/**
 * Checks if SVG content contains potentially dangerous elements.
 *
 * @param content - The SVG content string
 * @returns true if dangerous content is detected
 */
function containsDangerousSVGContent(content: string): boolean {
  const dangerousPatterns = [
    /<script[\s>]/i,
    /javascript:/i,
    /on\w+\s*=/i,        // Event handlers
    /<foreignObject/i,
    /xlink:href\s*=\s*["'](?!#)/i, // External references
    /data:/i,            // Data URIs
  ];

  return dangerousPatterns.some(pattern => pattern.test(content));
}

// ============================================================================
// Express Middleware
// ============================================================================

/**
 * Creates Express middleware for file upload validation.
 *
 * @param allowedTypes - Array of allowed MIME types
 * @param options - Additional validation options
 * @returns Express middleware function
 */
export function createFileUploadMiddleware(
  allowedTypes: string[],
  options: FileValidationOptions = {}
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Check if there are files to validate
    const files = getFilesFromRequest(req);

    if (files.length === 0) {
      return next();
    }

    for (const file of files) {
      const result = validateFileUpload(
        file.buffer,
        file.originalname,
        file.mimetype,
        {
          ...options,
          allowedTypes,
        }
      );

      if (!result.valid) {
        res.status(400).json({
          success: false,
          error: result.error,
          errorCode: result.errorCode,
          filename: file.originalname,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Update the file with sanitized name
      if (result.sanitizedFilename) {
        file.originalname = result.sanitizedFilename;
      }
    }

    next();
  };
}

/**
 * Extracts files from Express request (handles both single and multiple files).
 */
function getFilesFromRequest(req: Request): UploadedFile[] {
  const files: UploadedFile[] = [];

  // Single file upload (req.file)
  if ((req as any).file) {
    files.push((req as any).file);
  }

  // Multiple file uploads (req.files)
  if ((req as any).files) {
    const reqFiles = (req as any).files;

    if (Array.isArray(reqFiles)) {
      files.push(...reqFiles);
    } else if (typeof reqFiles === 'object') {
      // Handle fields with multiple files
      for (const fieldName of Object.keys(reqFiles)) {
        const fieldFiles = reqFiles[fieldName];
        if (Array.isArray(fieldFiles)) {
          files.push(...fieldFiles);
        }
      }
    }
  }

  return files;
}

/**
 * Creates middleware for validating weather data files specifically.
 *
 * @returns Express middleware for weather data validation
 */
export function createWeatherDataUploadMiddleware(): RequestHandler {
  const weatherDataTypes = [
    'application/x-netcdf',
    'application/x-hdf',
    'application/x-grib',
    'text/csv',
    'application/json',
  ];

  return createFileUploadMiddleware(weatherDataTypes, {
    maxSize: 500 * 1024 * 1024, // 500MB for weather data
    generateUniqueFilename: true,
    filenamePrefix: 'weather',
    requireMagicValidation: false, // Some weather formats don't have magic numbers
  });
}

/**
 * Creates middleware for validating image uploads.
 *
 * @param maxSizeMB - Maximum file size in megabytes
 * @returns Express middleware for image validation
 */
export function createImageUploadMiddleware(maxSizeMB: number = 10): RequestHandler {
  const imageTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
  ];

  return createFileUploadMiddleware(imageTypes, {
    maxSize: maxSizeMB * 1024 * 1024,
    generateUniqueFilename: true,
    requireMagicValidation: true,
  });
}

/**
 * Creates middleware for validating document uploads.
 *
 * @param maxSizeMB - Maximum file size in megabytes
 * @returns Express middleware for document validation
 */
export function createDocumentUploadMiddleware(maxSizeMB: number = 50): RequestHandler {
  const documentTypes = [
    'application/pdf',
    'text/csv',
    'application/json',
  ];

  return createFileUploadMiddleware(documentTypes, {
    maxSize: maxSizeMB * 1024 * 1024,
    generateUniqueFilename: true,
    requireMagicValidation: true,
  });
}

// ============================================================================
// Exports
// ============================================================================

export {
  FILE_SIGNATURES,
  BLOCKED_EXTENSIONS,
  MAX_FILE_SIZES,
};

export type {
  FileValidationResult as FileValidationResultType,
  FileValidationOptions as FileValidationOptionsType,
  UploadedFile as UploadedFileType,
};
