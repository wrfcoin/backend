/**
 * Display view of a core4 governance proposal record (backend#1242).
 *
 * core4 serializes GovernanceProposalRecord (shared-protocol
 * blockchain/state.rs) with no title or description, while the mobile
 * ProposalModel requires both as strings and fails the whole list without
 * them. This adds display fields DERIVED from what the record carries and
 * keeps every native field untouched, so consumers that read core4's own
 * names (yes_votes, votes_by_voter, ...) are unaffected.
 *
 * Nothing is invented: a LawCreate proposal carries its own title and
 * plain-language summary; every other update is described by its variant name
 * and value exactly as core4 stores them. Fields core4 has no source for
 * (created time, voting period as a duration, abstain votes) are left absent,
 * not guessed.
 */

type JsonRecord = Record<string, unknown>;

const MAX_DETAIL_LENGTH = 160;

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(renderValue).join(', ');
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, inner]) => `${key}=${renderValue(inner)}`)
      .join(', ');
  }
  return String(value);
}

function truncate(text: string): string {
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
}

/** core4's `update` is an externally tagged enum: `{ "<Variant>": <value> }`. */
function readUpdate(update: unknown): { variant: string; value: unknown } | null {
  if (typeof update === 'string' && update !== '') return { variant: update, value: undefined };
  if (!isRecord(update)) return null;
  const keys = Object.keys(update);
  if (keys.length !== 1) return null;
  return { variant: keys[0], value: update[keys[0]] };
}

/** Address([u8; 20]) serializes as a 20-byte array; render it as Address::to_hex does. */
function addressHex(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (
    Array.isArray(value)
    && value.length === 20
    && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return `0x${value.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}

export function toProposalView(record: unknown): unknown {
  if (!isRecord(record)) return record;

  const update = readUpdate(record.update);
  const lawCreate = update?.variant === 'LawCreate' && isRecord(update.value) ? update.value : null;
  const updateDetail = update
    ? truncate(update.value === undefined ? update.variant : `${update.variant}: ${renderValue(update.value)}`)
    : null;
  const lawSummary = isRecord(update?.value) ? nonEmptyString(update?.value.plain_language_summary) : null;
  const id = typeof record.id === 'string' ? record.id : String(record.id ?? '');

  const view: JsonRecord = {
    ...record,
    title: nonEmptyString(record.title)
      ?? nonEmptyString(lawCreate?.title)
      ?? updateDetail
      ?? `Proposal ${id}`.trim(),
    description: nonEmptyString(record.description)
      ?? lawSummary
      ?? updateDetail
      ?? '',
  };

  if (view.proposalType === undefined && typeof record.proposal_class === 'string') {
    view.proposalType = record.proposal_class;
  }
  if (view.votesFor === undefined && typeof record.yes_votes === 'number') {
    view.votesFor = record.yes_votes;
  }
  if (view.votesAgainst === undefined && typeof record.no_votes === 'number') {
    view.votesAgainst = record.no_votes;
  }
  const proposerAddress = addressHex(record.proposer);
  if (proposerAddress && view.proposerAddress === undefined) {
    view.proposerAddress = proposerAddress;
  }

  return view;
}
