import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHeader, checkMessage, MAX_HEADER } from '../scripts/check-commits.mjs';

test('accepts conventional headers', () => {
  for (const h of [
    'feat: add categorize tool',
    'fix(auth): refresh the session token',
    'feat!: drop the delete tool',
    'refactor(tools/transactions-live): split the schema',
    'ci: pin actions to commits',
    'chore(deps): bump graphql to 16.15.1',
  ]) {
    assert.deepEqual(checkHeader(h), [], h);
  }
});

test('rejects headers that are not conventional', () => {
  for (const h of [
    'Harden for categorize-only use',
    'feature: add X',
    'Feat: add X',
    'feat:add X',
    'feat : add X',
    'feat(): add X',
    'feat(Scope): add X',
    'feat: ',
    '',
  ]) {
    assert.ok(checkHeader(h).length > 0, h);
  }
});

test('rejects a trailing period and an over-long header', () => {
  assert.match(checkHeader('fix: tidy up.').join(), /period/);
  assert.match(checkHeader(`docs: ${'x'.repeat(MAX_HEADER)}`).join(), /characters long/);
});

test('checks the blank line between header and body', () => {
  assert.deepEqual(checkMessage('feat: add X\n\nWhy we need X.\n\nCo-Authored-By: A <a@example.com>'), []);
  assert.match(checkMessage('feat: add X\nno blank line').join(), /blank line/);
});

test('ignores git comment lines in hook mode', () => {
  const msg = '\nfix: handle empty pages\n\n# Please enter the commit message\n# ------------------------ >8 ------------------------\ndiff --git a b\n';
  assert.deepEqual(checkMessage(msg, { stripComments: true }), []);
});
