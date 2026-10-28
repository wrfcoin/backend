import express from "express";
import request from "supertest";
import { createBridgeClaimRouter } from "../../server/routes/bridge-claim-routes.js";
import type { BridgeClaims } from "../../server/bridges/claims.js";

test("mounted bridge routes enforce default-off and wallet authentication before calling service", async () => {
  let enabled = false;
  const issue = jest.fn(async () => ({
    claimId: "fixture",
    rewardEligible: false,
  }));
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createBridgeClaimRouter({
      claims: { issue } as unknown as BridgeClaims,
      enabled: () => enabled,
      walletOf: (req) =>
        req.headers.authorization === "fixture" ? "0x" + "a".repeat(40) : null,
    }),
  );
  expect(
    (
      await request(app)
        .post("/api/bridge-claims")
        .set("Authorization", "fixture")
        .send({})
    ).status,
  ).toBe(404);
  enabled = true;
  expect((await request(app).post("/api/bridge-claims").send({})).status).toBe(
    401,
  );
  expect(issue).not.toHaveBeenCalled();
  const response = await request(app)
    .post("/api/bridge-claims")
    .set("Authorization", "fixture")
    .send({ source: "aprs", deviceId: "K0TST", wallet: "attacker" });
  expect(response.status).toBe(200);
  expect(response.body.rewardEligible).toBe(false);
  expect(issue.mock.calls[0].slice(0, 3)).toEqual([
    "0x" + "a".repeat(40),
    "aprs",
    "K0TST",
  ]);
});

test("default router rejects an unverified bearer even with feature enabled", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", createBridgeClaimRouter({ enabled: () => true }));
  const response = await request(app)
    .post("/api/bridge-claims")
    .set("Authorization", "Bearer forged")
    .send({ source: "aprs", deviceId: "K0TST" });
  expect(response.status).toBe(401);
});

test("errors never return credential-bearing adapter messages", async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    createBridgeClaimRouter({
      enabled: () => true,
      walletOf: () => "0x" + "a".repeat(40),
      claims: {
        issue: async () => {
          throw new Error("https://vendor.invalid/?key=DO_NOT_RETURN");
        },
      } as unknown as BridgeClaims,
    }),
  );
  const response = await request(app)
    .post("/api/bridge-claims")
    .send({ source: "ambient", deviceId: "aabbccddee01" });
  expect(response.status).toBe(503);
  expect(JSON.stringify(response.body)).not.toContain("DO_NOT_RETURN");
});
