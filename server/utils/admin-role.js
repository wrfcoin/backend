/**
 * Exact admin membership on an identity already verified by authentication.
 * This predicate does not authenticate a token or issue admin privileges.
 */
function hasAdminRole(identity) {
  return Array.isArray(identity?.roles) && identity.roles.includes('admin');
}

module.exports = { hasAdminRole };
