import { createRequire } from 'module';

const nodeRequire = createRequire(__filename);
const { findOrphanedSources } = nodeRequire('../scripts/check-untracked-sources.cjs') as {
  findOrphanedSources: (files: string[]) => string[];
};

describe('check-untracked-sources hygiene guard', () => {
  it('flags the backend#715 slack bridge orphan path', () => {
    expect(findOrphanedSources(['services/slack-bridge.ts'])).toEqual([
      'services/slack-bridge.ts',
    ]);
  });

  it('flags source files across tracked service directories only', () => {
    expect(
      findOrphanedSources([
        'server/routes/slack-command-routes.ts',
        'shared/slack/constants.js',
        'docs/ops/slack-bridge-notes.md',
        'scripts/check-untracked-sources.cjs',
        'services/generated.txt',
      ])
    ).toEqual([
      'server/routes/slack-command-routes.ts',
      'shared/slack/constants.js',
    ]);
  });
});
