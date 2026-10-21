/**
 * Academic Partnership Service — .edu verification + pro-tier key provisioning
 * Issue #252
 */

import * as crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../database/connection.js';
import {
  academicApplications,
  marketplaceSubscriptions,
  ACADEMIC_STATUS,
  MARKETPLACE_TIERS,
  type AcademicStatus,
} from '../../shared/schema-marketplace.js';

export interface ApplyResult {
  success: boolean;
  applicationId?: string;
  status?: AcademicStatus;
  error?: string;
}

export interface ApplicationStatus {
  applicationId: string;
  status: AcademicStatus;
  institution: string;
  email: string;
  createdAt: Date;
  reviewedAt: Date | null;
  apiKey?: string; // only on approved
}

function generateAcademicKey(): string {
  return 'wrf_edu_' + crypto.randomBytes(24).toString('base64url');
}

function isEduEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.edu(\.[a-z]{2})?$/i.test(email);
}

export class AcademicService {
  async apply(
    userId: string,
    email: string,
    institution: string,
    researchDescription: string
  ): Promise<ApplyResult> {
    if (!isEduEmail(email)) {
      return { success: false, error: 'A valid .edu email address is required' };
    }

    // One application per email
    const existing = await db
      .select()
      .from(academicApplications)
      .where(eq(academicApplications.email, email.toLowerCase()))
      .limit(1);

    if (existing.length > 0) {
      return {
        success: false,
        error: `An application already exists for ${email} (status: ${existing[0].status})`,
      };
    }

    const inserted = await db
      .insert(academicApplications)
      .values({
        userId,
        email: email.toLowerCase(),
        institution,
        researchDescription,
        status: ACADEMIC_STATUS.PENDING,
      })
      .returning({ id: academicApplications.id });

    return {
      success: true,
      applicationId: inserted[0].id,
      status: ACADEMIC_STATUS.PENDING,
    };
  }

  async getStatus(userId: string): Promise<ApplicationStatus | null> {
    const rows = await db
      .select()
      .from(academicApplications)
      .where(eq(academicApplications.userId, userId))
      .limit(1);

    if (rows.length === 0) return null;

    const app = rows[0];
    return {
      applicationId: app.id,
      status: app.status as AcademicStatus,
      institution: app.institution,
      email: app.email,
      createdAt: app.createdAt,
      reviewedAt: app.reviewedAt,
      apiKey: app.status === ACADEMIC_STATUS.APPROVED && app.provisionedApiKey
        ? app.provisionedApiKey
        : undefined,
    };
  }

  /**
   * Auto-approve an academic application and provision a pro-tier key.
   * Called after email verification or manual admin approval.
   */
  async approve(applicationId: string): Promise<{ success: boolean; apiKey?: string }> {
    const rows = await db
      .select()
      .from(academicApplications)
      .where(eq(academicApplications.id, applicationId))
      .limit(1);

    if (rows.length === 0) return { success: false };

    const app = rows[0];
    const apiKey = generateAcademicKey();

    // Provision a pro-tier marketplace subscription
    await db
      .insert(marketplaceSubscriptions)
      .values({
        userId: app.userId,
        tier: MARKETPLACE_TIERS.PRO,
        apiKey,
      })
      .onConflictDoUpdate({
        target: [marketplaceSubscriptions.userId],
        set: {
          tier: MARKETPLACE_TIERS.PRO,
          apiKey,
          isActive: true,
          updatedAt: new Date(),
        },
      });

    const subscriptionRows = await db
      .select()
      .from(marketplaceSubscriptions)
      .where(eq(marketplaceSubscriptions.userId, app.userId))
      .limit(1);

    const persistedApiKey = subscriptionRows[0]?.apiKey ?? apiKey;

    await db
      .update(academicApplications)
      .set({
        status: ACADEMIC_STATUS.APPROVED,
        provisionedApiKey: persistedApiKey,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(academicApplications.id, applicationId));

    return { success: true, apiKey: persistedApiKey };
  }
}

export const academicService = new AcademicService();
