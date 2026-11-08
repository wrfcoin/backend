// The root package.json pins dompurify through an exact `overrides` entry, so
// Dependabot cannot raise it. This fails if the pin drifts below the first
// patched release (3.4.17).
const DOMPurify = require('dompurify');

function atLeast(version, min) {
  const parts = version.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < min.length; i += 1) {
    if ((parts[i] || 0) !== min[i]) return (parts[i] || 0) > min[i];
  }
  return true;
}

describe('dompurify override', () => {
  it('resolves to a patched dompurify (>= 3.4.17)', () => {
    expect(DOMPurify.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(atLeast(DOMPurify.version, [3, 4, 17])).toBe(true);
  });

  it('the version check rejects the old pin', () => {
    expect(atLeast('3.4.13', [3, 4, 17])).toBe(false);
    expect(atLeast('3.5.0', [3, 4, 17])).toBe(true);
  });
});
