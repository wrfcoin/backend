import express from "express";
import { peekWalletSubject } from "../middleware/authMiddleware.js";
import { BridgeClaims } from "../bridges/claims.js";
import {
  DryRunEmailSender,
  RecordedLicenceLookup,
  RecordedOwnershipProofReader,
} from "../bridges/proof.js";

export function createBridgeClaimRouter(
  deps: {
    claims?: BridgeClaims;
    enabled?: () => boolean;
    walletOf?: (req: express.Request) => string | null;
  } = {},
): express.Router {
  const enabled =
    deps.enabled ?? (() => process.env.BRIDGE_CLAIMS_ENABLED === "1");
  // Production has no fixture records or real proof adapters. Enabling the flag alone
  // cannot verify real hardware; only injected recorded test evidence can verify.
  const claims =
    deps.claims ??
    new BridgeClaims({
      enabled,
      transaction: async (fn) =>
        (await import("../../database/connection.js")).executeTransaction(fn),
      licences: new RecordedLicenceLookup([]),
      email: new DryRunEmailSender(),
      proofs: new RecordedOwnershipProofReader([]),
    });
  const router = express.Router();
  router.use("/bridge-claims", (req, res, next) => {
    const wallet = (deps.walletOf ?? peekWalletSubject)(req);
    if (!wallet) {
      res.status(401).json({ error: "AUTH_REQUIRED" });
      return;
    }
    if (!enabled()) {
      res.status(404).json({ error: "BRIDGES_DISABLED" });
      return;
    }
    res.locals.bridgeWallet = wallet;
    next();
  });
  const handle =
    (
      fn: (req: express.Request, res: express.Response) => Promise<unknown>,
    ): express.RequestHandler =>
    async (req, res) => {
      try {
        res.json(await fn(req, res));
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const allowed = [
          "INVALID_IDENTITY",
          "AUTH_REQUIRED",
          "BRIDGES_DISABLED",
          "RATE_LIMITED",
          "DEVICE_CLAIMED",
          "CLAIM_NOT_PENDING",
          "PROOF_REQUIRED",
          "CHALLENGE_EXPIRED_OR_USED",
          "REFERENCE_ONLY",
          "LICENCE_CHANGED",
          "VENDOR_REVOKED",
          "NOT_FOUND",
          "DELIVERY_FAILED",
        ];
        const code = allowed.includes(message)
          ? message
          : "SERVICE_UNAVAILABLE";
        res
          .status(
            code === "SERVICE_UNAVAILABLE"
              ? 503
              : code === "RATE_LIMITED"
                ? 429
                : code === "NOT_FOUND"
                  ? 404
                  : 400,
          )
          .json({ error: code, rewardEligible: false });
      }
    };
  router.post(
    "/bridge-claims",
    handle((req, res) =>
      claims.issue(
        res.locals.bridgeWallet,
        req.body?.source,
        req.body?.deviceId,
        req.ip ?? "",
      ),
    ),
  );
  router.post(
    "/bridge-claims/challenges/:challengeId/verify",
    handle((req, res) =>
      claims.verify(
        res.locals.bridgeWallet,
        String(req.params.challengeId),
        req.body?.code,
        req.ip ?? "",
      ),
    ),
  );
  router.get(
    "/bridge-claims/:claimId",
    handle((req, res) =>
      claims.status(res.locals.bridgeWallet, String(req.params.claimId)),
    ),
  );
  router.delete(
    "/bridge-claims/:claimId",
    handle(async (req, res) => {
      await claims.revoke(res.locals.bridgeWallet, String(req.params.claimId));
      return { state: "revoked", rewardEligible: false };
    }),
  );
  return router;
}
