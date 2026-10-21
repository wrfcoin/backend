const { core4TraceHeaders } = require('./core4-reader-credential');
const CONTRIBUTOR_UNCONFIGURED = 'CORE4_CONTRIBUTOR_CREDENTIAL_UNCONFIGURED';
const CONTRIBUTOR_MESSAGE = 'This operation is unavailable: the backend core4 Contributor credential is not configured';

// Call only after the route's authentication/ownership checks pass.
function core4ContributorHeaders(requestHeaders = {}) {
  const token = process.env.WRFCOIN_CONTRIBUTOR_TOKEN?.trim();
  if (!token) throw Object.assign(new Error(CONTRIBUTOR_MESSAGE), { code: CONTRIBUTOR_UNCONFIGURED });
  return { authorization: `Bearer ${token}`, ...core4TraceHeaders(requestHeaders) };
}

function sendContributorCredentialUnavailable(res) {
  return res.status(503).json({ success: false, error: {
    code: CONTRIBUTOR_UNCONFIGURED, message: CONTRIBUTOR_MESSAGE,
  } });
}

module.exports = { core4ContributorHeaders, sendContributorCredentialUnavailable, CONTRIBUTOR_UNCONFIGURED };
