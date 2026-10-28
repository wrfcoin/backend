# Official warning precedence

WRFCoin fills gaps and never replaces or contradicts a national warning service.
All events in this implementation are shadow research records; none reach a person.

Rules and executable evidence in `__tests__/services/shadow-alert-engine.test.ts`:

1. Overlap in cell, hazard and event interval suppresses the advisory and retains the
   official ID, HTTPS source and interval (`official overlap suppresses`). An upstream
   adapter must conservatively map every intersected cell, including polygon borders.
2. A newly received official warning suppresses an existing event even without fresh
   station readings (`late official warning supersedes existing advisory`).
3. Invalid official coverage fails closed (`malformed official coverage rejects`).
   Empty input is valid only for a verified complete official-history export. It must
   never represent an unavailable live feed. No live adapter is shipped.
4. No official warning is not an all-clear. A gap event is an advisory with limited
   corroborated confidence, expiry and provenance, never a certainty claim.
5. Shadow evaluation never constructs a sender (`no sender is constructed`). This
   policy and a synthetic replay are not permission to enable delivery.

Official information must be presented as authoritative in any future consumer.
Once suppressed, a historical event remains suppressed even after the official
warning expires. A replay never rewrites that audit trail as an independent warning.
