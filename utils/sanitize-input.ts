/**
 * Input Sanitization Utilities
 * Provides basic input sanitization for security purposes
 */

/**
 * Sanitizes input by removing dangerous characters and patterns
 * @param input - The input string to sanitize
 * @returns The sanitized string
 */
export function sanitizeInput(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }

  return (
    input
      // Remove HTML tags
      .replace(/<[^>]*>/g, '')
      // Remove script tags completely
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      // Remove SQL injection patterns
      .replace(/[\';\"\\]/g, '')
      // Remove potential XSS vectors
      .replace(/javascript:|vbscript:|onload=|onerror=/gi, '')
      // Remove path traversal attempts
      .replace(/\.\.\/|\.\.\\|\.\.\\/g, '')
      // Trim whitespace
      .trim()
      // Limit length to prevent DoS
      .substring(0, 1000)
  );
}

/**
 * Validates if a string is a valid UUID format
 * @param uuid - The UUID string to validate
 * @returns True if valid UUID format
 */
export function isValidUUID(uuid: string): boolean {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Sanitizes filename by removing dangerous characters
 * @param filename - The filename to sanitize
 * @returns The sanitized filename
 */
export function sanitizeFilename(filename: string): string {
  if (typeof filename !== 'string') {
    return '';
  }

  return (
    filename
      // Remove path separators
      .replace(/[\/\\]/g, '')
      // Remove dangerous characters
      .replace(/[<>:"|?*]/g, '')
      // Remove control characters
      .replace(/[\x00-\x1f]/g, '')
      // Trim periods and spaces
      .replace(/^[\s\.]+|[\s\.]+$/g, '')
      // Limit length
      .substring(0, 255)
  );
}
