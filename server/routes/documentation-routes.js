/**
 * Documentation API routes backed only by checked-in repository documents.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const documentationIndex = require('../data/documentation-index.json');
const { notWiredEnvelope } = require('../middleware/require-wired-storage');
const { logger } = require('../utils/logger');
const { hasOperatorToken } = require('../middleware/operator-token-auth');

const router = express.Router();
const repositoryRoot = path.resolve(__dirname, '..', '..');

function publicEntry(entry) {
  const { internal, ...rest } = entry;
  return {
    ...rest,
    format: path.extname(entry.path).slice(1) || 'text',
  };
}

// backend#1224: `internal` docs name hosts, SSH commands and debug routes.
// They are served only to operator-token callers; for anyone else they do not
// exist (absent from listings, 404 by id).
function visibleEntries(req) {
  return hasOperatorToken(req)
    ? documentationIndex
    : documentationIndex.filter((entry) => !entry.internal);
}

router.get('/', (req, res) => {
  const resources = visibleEntries(req).map(publicEntry);
  res.json({ count: resources.length, resources });
});

router.get('/categories/list', (req, res) => {
  const counts = visibleEntries(req).reduce((result, entry) => {
    result[entry.category] = (result[entry.category] || 0) + 1;
    return result;
  }, {});
  const categories = Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, count]) => ({ id, name: id, count }));

  res.json({ count: categories.length, categories });
});

router.get('/search/query', (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!query) {
    return res.status(400).json({
      error: true,
      message: 'Search query parameter "q" is required',
    });
  }

  const normalizedQuery = query.toLocaleLowerCase();
  const results = visibleEntries(req)
    .filter((entry) =>
      `${entry.title}\n${entry.category}`.toLocaleLowerCase().includes(normalizedQuery),
    )
    .map(publicEntry);

  return res.json({ query, count: results.length, results });
});

router.get('/api/:route', (req, res) => {
  return res.status(501).json(notWiredEnvelope({
    capability: 'documentation.api-reference',
    message: `API reference for ${req.params.route} is not wired to a checked-in OpenAPI source.`,
    see: 'wrfcoin/backend#1180',
  }));
});

router.get('/tutorials/list', (_req, res) => {
  return res.status(501).json(notWiredEnvelope({
    capability: 'documentation.tutorials',
    message: 'Tutorial metadata is not wired to checked-in tutorial sources.',
    see: 'wrfcoin/backend#1180',
  }));
});

router.get('/:id', (req, res) => {
  const entry = visibleEntries(req).find((candidate) => candidate.id === req.params.id);
  if (!entry) {
    return res.status(404).json({ error: true, message: 'Documentation resource not found' });
  }

  try {
    const content = fs.readFileSync(path.join(repositoryRoot, entry.path), 'utf8');
    return res.json({ ...publicEntry(entry), content });
  } catch (error) {
    logger.error(`Error reading checked-in documentation ${entry.path}:`, error);
    return res.status(500).json({
      error: true,
      message: 'Failed to read documentation resource',
    });
  }
});

module.exports = router;
