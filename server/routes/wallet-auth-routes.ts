// Backwards-compatible import path. The implementation lives in one module so
// the public API route and direct service consumers cannot drift apart.
export {
  ED25519_WALLET_LOGIN_DOMAIN,
  SESSION_KEY_WALLET_LOGIN_DOMAIN,
  buildSessionKeyWalletLoginMessage,
  sessionKeyAllowsLogin,
  buildEd25519WalletLoginMessage,
  buildWalletLoginMessage,
  createWalletAuthService,
  parseWalletLoginScheme,
  type WalletLoginChallenge,
  type WalletLoginScheme,
} from './wallet-auth-service.js';
