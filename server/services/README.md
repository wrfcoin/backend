# File Upload & Storage System - Permission-Based Access Control

## Overview

This implementation provides a comprehensive user permission-based file access control system for
Task 59. The system implements Role-Based Access Control (RBAC) with hierarchical permissions,
Redis-based caching for performance, and HashiCorp Vault integration for secure key management.

## Architecture Components

### 1. Database Schema (`file-schema.ts`)

The system uses four main database tables:

- **`files`** - Stores file metadata and storage information
- **`file_permissions`** - Manages user permissions for files (READ, WRITE, DELETE, SHARE, ADMIN)
- **`file_access_logs`** - Audit trail for all file access attempts
- **`file_shares`** - Manages file sharing tokens and configurations

### 2. Core Services

#### File Permission Service (`file-permission-service.ts`)

- **Purpose**: Core RBAC implementation
- **Key Functions**:
  - `checkFilePermission()` - Validates user permissions with caching
  - `grantFilePermission()` - Grant permissions to users
  - `revokeFilePermission()` - Revoke user permissions
  - `getFilePermissions()` - List all permissions for a file
  - `createFileShare()` - Create secure sharing tokens

#### Enhanced File Storage Service (`enhanced-file-storage.ts`)

- **Purpose**: File management with permission integration
- **Key Functions**:
  - `createFile()` - Create file records with encryption support
  - `getFile()` - Retrieve files with permission checking
  - `listFiles()` - List accessible files with filtering
  - `searchFiles()` - Full-text search with permissions
  - `updateFile()` - Update file metadata
  - `deleteFile()` - Soft delete with permission cleanup

#### Vault Integration Service (`vault-integration-service.ts`)

- **Purpose**: Secure key management using HashiCorp Vault
- **Key Functions**:
  - `generateFileEncryptionKey()` - Create encryption keys for sensitive files
  - `generatePermissionSigningKey()` - Create RSA keys for permission tokens
  - `encryptData()` / `decryptData()` - Encrypt/decrypt sensitive data
  - `signPermissionToken()` / `verifyPermissionToken()` - Token signing/verification

#### File Permission Coordinator (`file-permission-coordinator.ts`)

- **Purpose**: Coordinates between services and manages system health
- **Key Functions**:
  - Message bus communication via Redis
  - System health monitoring
  - Metrics collection and reporting
  - Automated cleanup of expired permissions

### 3. API Routes (`enhanced-upload.ts`)

Enhanced upload routes with permission checking:

- **POST** `/api/upload/file` - Multi-file upload with security scanning
- **GET** `/api/upload/file/:fileId` - Secure file download with pre-signed URLs
- **GET** `/api/upload/files` - List accessible files with pagination
- **POST** `/api/upload/file/:fileId/permissions` - Grant file permissions

## Permission Hierarchy

The system implements a hierarchical permission model:

1. **READ** - View file metadata and download
2. **WRITE** - Modify file metadata and content
3. **DELETE** - Remove files (soft delete)
4. **SHARE** - Create sharing tokens and grant permissions
5. **ADMIN** - All permissions + user management

Higher permissions include all lower permissions (e.g., ADMIN includes SHARE, DELETE, WRITE, READ).

## Security Features

### 1. File Security

- **Virus Scanning**: ClamAV integration for malware detection
- **File Type Validation**: Magic number verification beyond MIME types
- **Encryption**: Automatic encryption for sensitive file types using Vault
- **Secure Storage**: AWS S3 with server-side encryption

### 2. Access Control

- **Permission Caching**: Redis caching with TTL for performance
- **Audit Logging**: Complete audit trail of all file access attempts
- **Token-Based Sharing**: Secure sharing with optional password protection
- **IP & Session Tracking**: Context-aware access logging

### 3. Key Management

- **Vault Integration**: HashiCorp Vault for encryption key storage
- **Key Rotation**: Automated key rotation capabilities
- **RSA Signatures**: Digital signatures for permission tokens

## Performance Optimizations

### 1. Redis Caching

- **Permission Cache**: 5-minute TTL for permission checks
- **File Metadata Cache**: 1-hour TTL for file information
- **Cache Invalidation**: Automatic cache clearing on permission changes

### 2. Database Optimization

- **Indexes**: Comprehensive indexing strategy for fast queries
- **Views**: Pre-computed views for common queries
- **Pagination**: Efficient pagination for large file lists

## Installation & Configuration

### 1. Database Setup

```sql
-- Run the migration
\i backend/database/migrations/001_create_file_tables.sql
```

### 2. Environment Variables

```bash
# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password

# Vault Configuration
VAULT_ENDPOINT=http://localhost:8200
VAULT_TOKEN=your_vault_token
VAULT_MOUNT=secret
VAULT_NAMESPACE=your_namespace

# AWS S3 Configuration
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_REGION=us-east-1
S3_BUCKET_NAME=your_bucket_name

# ClamAV Configuration
CLAMAV_HOST=localhost
CLAMAV_PORT=3310
```

### 3. Service Initialization

```typescript
import { filePermissionCoordinator } from './file-permission-coordinator';

// Initialize the coordination framework
await filePermissionCoordinator.initialize();
```

## Usage Examples

### 1. Check File Permission

```typescript
import { filePermissionService } from './file-permission-service';

const result = await filePermissionService.checkFilePermission(userId, fileId, 'READ', {
  ipAddress: req.ip,
  userAgent: req.get('User-Agent'),
  sessionId: req.session.id,
});

if (result.hasPermission) {
  // Allow access
} else {
  // Deny access - reason in result.reason
}
```

### 2. Grant File Permission

```typescript
await filePermissionService.grantFilePermission({
  granterId: currentUserId,
  userId: targetUserId,
  fileId: fileId,
  permissions: ['READ', 'WRITE'],
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
});
```

### 3. Create Secure File Share

```typescript
const share = await filePermissionService.createFileShare(userId, fileId, {
  shareType: 'LINK',
  permissions: ['READ'],
  maxAccesses: 10,
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
  passwordProtected: true,
  password: 'secure-password',
});

// Share URL: /api/upload/share/${share.shareToken}
```

### 4. Upload File with Permissions

```typescript
import { enhancedFileStorageService } from './enhanced-file-storage';

const file = await enhancedFileStorageService.createFile(userId, {
  originalName: 'document.pdf',
  filename: 'secure_document.pdf',
  mimeType: 'application/pdf',
  fileSize: 1024000,
  storageProvider: 'S3',
  storagePath: 's3://bucket/path/file',
  checksum: 'sha256-hash',
  visibility: 'PRIVATE',
  tags: ['document', 'important'],
  encryptionRequired: true,
});
```

## Monitoring & Health Checks

### 1. System Health

```typescript
const health = filePermissionCoordinator.getHealthStatus();
console.log('System Health:', health);
```

### 2. Metrics Collection

```typescript
const metrics = filePermissionCoordinator.getMetrics();
console.log('System Metrics:', metrics);
```

### 3. Audit Logs

All file access attempts are logged to `file_access_logs` table with:

- User information
- Access context (IP, User-Agent, Session)
- Success/failure status
- Error details if applicable
- Performance metrics (duration, bytes transferred)

## Testing

Comprehensive test suite included in `__tests__/services/file-permission-service.test.ts`:

```bash
# Run tests
npm test backend/__tests__/services/file-permission-service.test.ts
```

Tests cover:

- Permission checking logic
- Cache behavior
- Error handling
- Database integration
- Security scenarios

## Maintenance

### 1. Cleanup Tasks

The system includes automated cleanup:

- **Expired Permissions**: Hourly cleanup of expired permissions
- **Old Audit Logs**: Retention of 90 days of access logs
- **Inactive Shares**: Cleanup of expired sharing tokens

### 2. Key Rotation

```typescript
// Rotate encryption keys
const newKey = await vaultIntegrationService.rotatePermissionKey(oldKeyId);
```

### 3. Performance Monitoring

- Monitor Redis cache hit rates
- Track database query performance
- Monitor file access patterns
- Alert on permission failures

## Integration with Existing Systems

This implementation seamlessly integrates with the existing WRFCoin infrastructure:

1. **Enhanced Storage Patterns**: Uses the same field name conversion patterns as
   `enhanced-storage.ts`
2. **Database Integration**: Leverages existing Drizzle ORM setup
3. **Redis Integration**: Uses existing Redis configuration
4. **Authentication**: Integrates with existing JWT authentication middleware
5. **Logging**: Uses existing logging infrastructure

## Security Considerations

1. **Input Validation**: All inputs are sanitized and validated
2. **SQL Injection Prevention**: Parameterized queries via Drizzle ORM
3. **Rate Limiting**: Implement rate limiting on sensitive endpoints
4. **HTTPS Only**: All file operations should use HTTPS
5. **Key Security**: Vault keys should be rotated regularly
6. **Audit Compliance**: Complete audit trail for compliance requirements

## Future Enhancements

1. **Multi-tenancy**: Support for multiple organizations
2. **Advanced Sharing**: Time-limited sharing with view restrictions
3. **Content Analytics**: File usage analytics and insights
4. **Integration APIs**: REST and GraphQL APIs for external systems
5. **Mobile SDKs**: Mobile client libraries for file operations
