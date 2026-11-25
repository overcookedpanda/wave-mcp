#!/usr/bin/env node
// Checks commit messages and pull request titles against Conventional Commits 1.0
// (https://www.conventionalcommits.org/en/v1.0.0/). No dependencies.
//
//   node scripts/check-commits.mjs --range <base>..<head>   every non-merge commit in a range
//   node scripts/check-commits.mjs --title "<text>"          a pull request title
//   node scripts/check-commits.mjs --message-file <path>     one message (the commit-msg hook)
//
// A header looks like `type(scope)!: summary`. The scope and the `!` (breaking
// change) are optional. A body, if any, is separated from the header by a blank line.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];
export const MAX_HEADER = 100;
const HEADER = new RegExp(`^(?:${TYPES.join('|')})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: \\S`);

export function checkHeader(header) {
  const problems = [];
  if (!HEADER.test(header)) {
    problems.push(`should look like "type(scope)!: summary", where type is one of ${TYPES.join(', ')} and scope and ! are optional`);
  }
  if (header.length > MAX_HEADER) problems.push(`is ${header.length} characters long; keep it to ${MAX_HEADER}`);
  if (/\.\s*$/.test(header)) problems.push('should not end with a period');
  return problems;
}

export function checkMessage(message, { stripComments = false } = {}) {
  let lines = message.replace(/\r\n/g, '\n').split('\n');
  if (stripComments) {
    const cut = lines.findIndex((l) => /^# -+ >8 -+/.test(l)); // `git commit -v` scissors line
    if (cut !== -1) lines = lines.slice(0, cut);
    lines = lines.filter((l) => !l.startsWith('#'));
  }
  while (lines.length && lines[0].trim() === '') lines.shift();
  const problems = checkHeader(lines[0] ?? '');
  if (lines.length > 1 && lines[1].trim() !== '') problems.push('needs a blank line between the header and the body');
  return problems;
}

function commitsInRange(range) {
  const out = execFileSync('git', ['log', '--no-merges', '--format=%H%x00%B%x1e', range], { encoding: 'utf8' });
  return out
    .split('\x1e')
    .map((chunk) => chunk.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((chunk) => {
      const [sha, message] = chunk.split('\x00');
      return { sha, message: message.replace(/\n+$/, '') };
    });
}

function report(label, text, problems) {
  if (!problems.length) return 0;
  console.error(`✗ ${label}: "${text.split('\n')[0]}"`);
  for (const p of problems) console.error(`    - ${p}`);
  return 1;
}

function main(argv) {
  const [flag, value] = argv;
  let failures = 0;
  if (flag === '--range' && value) {
    const commits = commitsInRange(value);
    for (const { sha, message } of commits) failures += report(`commit ${sha.slice(0, 7)}`, message, checkMessage(message));
    if (!failures) console.log(`✓ ${commits.length} commit(s) in ${value} follow Conventional Commits`);
  } else if (flag === '--title' && value !== undefined) {
    failures += report('PR title', value, checkHeader(value));
    if (!failures) console.log('✓ PR title follows Conventional Commits');
  } else if (flag === '--message-file' && value) {
    const message = readFileSync(value, 'utf8');
    if (/^(Merge|fixup! |squash! |amend! )/.test(message)) return 0; // git's own messages; squashed before merge
    failures += report('commit message', message, checkMessage(message, { stripComments: true }));
  } else {
    console.error('usage: check-commits.mjs --range <base>..<head> | --title "<text>" | --message-file <path>');
    return 2;
  }
  if (failures) console.error('\nSee https://www.conventionalcommits.org/en/v1.0.0/ (examples: "feat: add X", "fix(auth)!: drop Y").');
  return failures ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
