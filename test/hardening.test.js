// This fork's defaults: credentials only go to waveapps.com, no tools that
// email customers, and transaction edits limited to categorizing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect, tempCredentials } from './helpers/harness.js';
import { BUSINESS, TOKEN, createFakeWave } from './helpers/fake-wave.js';
import { ACC, SESSION, combineFakes, createFakeInternal, makeTx } from './helpers/fake-internal.js';
import { loadConfig, pinnedWaveUrl } from '../src/config.js';

const BOTH = `WAVE_ACCESS_TOKEN=${TOKEN}\nWAVE_SESSION_TOKEN=${SESSION}\n`;
const DEFAULTS = { WAVE_MCP_ALLOW_EMAIL: '', WAVE_MCP_ALLOW_LEDGER_EDITS: '', WAVE_MCP_ALLOW_TRANSFERS: '' };

async function hardened(t, { transactions } = {}) {
  const internal = createFakeInternal(transactions ? { transactions } : {});
  const h = await connect(combineFakes(createFakeWave(), internal), { credentials: tempCredentials(BOTH), env: { WAVE_BUSINESS_ID: BUSINESS.id, ...DEFAULTS } });
  t.after(h.close);
  return { ...h, internal };
}

const patches = (internal) => internal.calls.filter((c) => c.name === 'TransactionPatch');

test('endpoints are pinned to https on waveapps.com', () => {
  assert.equal(pinnedWaveUrl('https://gql.waveapps.com/graphql/public', 'X'), 'https://gql.waveapps.com/graphql/public');
  assert.equal(pinnedWaveUrl('https://waveapps.com/x', 'X'), 'https://waveapps.com/x');
  for (const bad of [
    'http://gql.waveapps.com/graphql/public',
    'https://evil.example/graphql',
    'https://evilwaveapps.com/graphql',
    'https://gql.waveapps.com.evil.example/graphql',
    'https://gql.waveapps.com:8443/graphql',
    'https://user:pw@gql.waveapps.com/graphql',
    'not a url',
  ]) {
    assert.throws(() => pinnedWaveUrl(bad, 'WAVE_API_URL'), /WAVE_API_URL/, bad);
  }
  for (const key of ['WAVE_API_URL', 'WAVE_INTERNAL_API_URL', 'WAVE_OAUTH_BASE_URL']) {
    assert.throws(() => loadConfig({ [key]: 'https://attacker.example/graphql' }), new RegExp(key));
  }
  const config = loadConfig({});
  assert.equal(config.allowEmail, false);
  assert.equal(config.allowLedgerEdits, false);
  assert.equal(config.allowTransfers, false);
});

test('by default no email tools and no transaction delete are registered', async (t) => {
  const h = await hardened(t);
  const names = (await h.client.listTools()).tools.map((x) => x.name);
  assert.deepEqual(names.filter((n) => /^wave_send_/.test(n)), []);
  assert.ok(!names.includes('wave_delete_transaction'));
  assert.ok(names.includes('wave_update_transaction'));
  assert.ok(!names.includes('wave_match_transfer'), 'transfer matching is opt-in');
  assert.ok(names.includes('wave_find_transfer_matches'), 'finding matches only reads');
  assert.equal(names.length, 68);
});

test('by default edits are limited to categorizing', async (t) => {
  const h = await hardened(t, { transactions: [makeTx(1, { amount: '22.60', category: ACC.uncat })] });
  const { tools } = await h.client.listTools();
  const props = Object.keys(tools.find((x) => x.name === 'wave_update_transaction').inputSchema.properties);
  for (const field of ['date', 'description', 'accountId', 'amount']) assert.ok(!props.includes(field), field);

  for (const args of [{ amount: '1.00' }, { date: '2026-01-01' }, { description: 'x' }, { accountId: ACC.cash.id }, { categoryId: ACC.marketing.id, amount: '1.00' }]) {
    const r = await h.call('wave_update_transaction', { id: 'tx-1', ...args });
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(patches(h.internal).length, 0, 'nothing was sent to Wave');

  const ok = await h.call('wave_update_transaction', { id: 'tx-1', categoryId: ACC.marketing.id, notes: 'ad spend' });
  assert.equal(ok.isError, false, ok.text);
  const input = patches(h.internal).at(-1).variables.input;
  assert.equal(input.lineItems[0].category.accountId, ACC.marketing.id);
  assert.equal(input.anchorLineItem, undefined, 'bank side untouched');

  const split = await h.call('wave_update_transaction', { id: 'tx-1', lines: [{ order: 1, accountId: ACC.marketing.id, amount: '17.35' }, { accountId: ACC.uncat.id, amount: '5.25' }] });
  assert.equal(split.isError, false, split.text);
  const unbalanced = await h.call('wave_update_transaction', { id: 'tx-1', lines: [{ order: 1, accountId: ACC.marketing.id, amount: '30.00' }] });
  assert.equal(unbalanced.isError, true, 'a split cannot change the total');
});

test('by default journal entry lines cannot be edited', async (t) => {
  const tx = makeTx(1);
  tx.anchorLineItem = null;
  tx.direction = null;
  tx.lineItems = [
    { ...tx.lineItems[0], order: 0, itemType: 'DEBIT', amount: '5', taxAction: null },
    { ...tx.lineItems[0], order: 1, itemType: 'CREDIT', amount: '5', taxAction: null, account: ACC.uncat },
  ];
  const h = await hardened(t, { transactions: [tx] });
  const r = await h.call('wave_update_transaction', { id: 'tx-1', lines: [{ order: 0, accountId: ACC.marketing.id, amount: '5', side: 'debit' }, { order: 1, accountId: ACC.uncat.id, amount: '5', side: 'credit' }] });
  assert.equal(r.isError, true);
  assert.match(r.text, /journal entr/i);
  assert.equal(patches(h.internal).length, 0);
});
