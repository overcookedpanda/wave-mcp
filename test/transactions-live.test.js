import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { connect, tempCredentials } from './helpers/harness.js';
import { BUSINESS, TOKEN, createFakeWave } from './helpers/fake-wave.js';
import { ACC, GST, SESSION, combineFakes, createFakeInternal, makeTx } from './helpers/fake-internal.js';
import { buildPatch } from '../src/tools/transactions-live.js';
import { describeInternalInputErrors } from '../src/wave/errors.js';
import { extractCredential, runLoginCli } from '../src/auth/login-cli.js';
import { loadConfig } from '../src/config.js';

const BOTH = `WAVE_ACCESS_TOKEN=${TOKEN}\nWAVE_SESSION_TOKEN=${SESSION}\n`;

async function live(t, { transactions, credentials = BOTH, reconciledAccounts } = {}) {
  const internal = createFakeInternal({ ...(transactions ? { transactions } : {}), reconciledAccounts });
  const h = await connect(combineFakes(createFakeWave(), internal), { credentials: tempCredentials(credentials), env: { WAVE_BUSINESS_ID: BUSINESS.id } });
  t.after(h.close);
  return { ...h, internal };
}

const patches = (internal) => internal.calls.filter((c) => c.name === 'TransactionPatch');

test('live transactions need a web session, and say how to get one', async (t) => {
  const h = await live(t, { credentials: `WAVE_ACCESS_TOKEN=${TOKEN}\n` });
  const r = await h.call('wave_list_transactions');
  assert.equal(r.isError, true);
  assert.match(r.text, /in a terminal on .+ run: node \S*wave-mcp\.js login /);
  assert.equal(h.internal.calls.length, 0, 'no request without a session');
  const c = await h.call('wave_get_context');
  assert.match(c.json.auth.webSession, /not configured/);
  assert.match(c.json.auth.signIn, /^node \S*bin\/wave-mcp\.js login /);
});

test('a login in another terminal takes effect on the next call, without a restart', async (t) => {
  const creds = tempCredentials(`WAVE_ACCESS_TOKEN=${TOKEN}\n`);
  const internal = createFakeInternal();
  const h = await connect(combineFakes(createFakeWave(), internal), { credentials: creds, env: { WAVE_BUSINESS_ID: BUSINESS.id } });
  t.after(h.close);
  assert.equal((await h.call('wave_list_transactions', { pageSize: 1 })).isError, true);
  await new Promise((r) => setTimeout(r, 20)); // distinct mtime
  fs.writeFileSync(creds.file, BOTH, { mode: 0o600 });
  const r = await h.call('wave_list_transactions', { pageSize: 1 });
  assert.equal(r.isError, false, r.text);
});

test('an expired web session gives the login hint, without retry loops', async (t) => {
  const h = await live(t, { credentials: `WAVE_ACCESS_TOKEN=${TOKEN}\nWAVE_SESSION_TOKEN=old-session\n` });
  const r = await h.call('wave_get_transaction', { id: 'tx-1' });
  assert.equal(r.isError, true);
  assert.match(r.text, /rejected the stored web session.*wave-mcp\.js login/);
  assert.equal(h.internal.calls.length, 1);
  assert.ok(!r.text.includes('old-session'));
});

test('a web session alone also serves the public API', async (t) => {
  const h = await live(t, { credentials: `WAVE_SESSION_TOKEN=${TOKEN}\n` });
  const c = await h.call('wave_get_context');
  assert.equal(c.isError, false, c.text);
  assert.equal(c.json.auth.mode, 'session');
  assert.equal((await h.call('wave_list_customers', { pageSize: 1 })).isError, false);
});

test('list: filters, cursor pagination, page totals and summaries', async (t) => {
  const h = await live(t);
  const p1 = await h.call('wave_list_transactions', { pageSize: 10 });
  assert.equal(p1.isError, false, p1.text);
  assert.equal(p1.json.count, 10);
  assert.equal(p1.json.hasMore, true);
  assert.equal(p1.json.items[0].date, '2026-10-30', 'newest first');
  assert.equal(p1.json.pageTotals.withdrawals, '100.00');
  assert.deepEqual(Object.keys(p1.json.items[0]).sort(), ['account', 'amount', 'category', 'date', 'description', 'direction', 'id', 'source', 'verified'].sort());
  const p2 = await h.call('wave_list_transactions', { pageSize: 10, cursor: p1.json.nextCursor });
  assert.equal(p2.json.items[0].date, '2026-10-20');

  const f = await h.call('wave_list_transactions', { search: 'purchase 1', startDate: '2026-10-10', endDate: '2026-10-19', accountId: ACC.cash.id, sort: 'date_asc', uncategorizedOnly: true, categoryIds: [ACC.marketing.id] });
  const sent = h.internal.calls.findLast((c) => c.name === 'ListTransactions').variables;
  assert.deepEqual(sent.filters, { startDate: '2026-10-10', endDate: '2026-10-19', description: 'purchase 1', anchorId: ACC.cash.id, categoryIds: [ACC.marketing.id, ACC.uncat.id, ACC.uncatIncome.id] });
  assert.deepEqual(sent.sort, ['DATE_ASC']);
  assert.equal(f.json.items[0].date, '2026-10-10');
});

test('list: a page over the size cap is shortened and the cursor resumes after the last row', async (t) => {
  const internal = createFakeInternal();
  const h = await connect(combineFakes(createFakeWave(), internal), { credentials: tempCredentials(BOTH), env: { WAVE_BUSINESS_ID: BUSINESS.id, WAVE_MCP_MAX_RESPONSE_CHARS: '4000' } });
  t.after(h.close);
  const seen = [];
  let cursor;
  let shortened = 0;
  for (let i = 0; i < 40; i++) {
    const r = await h.call('wave_list_transactions', { pageSize: 100, detail: 'full', ...(cursor ? { cursor } : {}) });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.text.length <= 4000, `page ${i} is ${r.text.length} chars`);
    assert.equal(r.json.truncated, undefined, 'never trimmed after the fact');
    if (r.json.shortened) shortened++;
    seen.push(...r.json.items.map((x) => x.id));
    if (!r.json.hasMore) break;
    cursor = r.json.nextCursor;
  }
  assert.ok(shortened > 0, 'the cap was exercised');
  assert.equal(seen.length, 30);
  assert.equal(new Set(seen).size, 30, 'every transaction exactly once');
});

test('get: full detail with lines, tax, sequence and editable fields', async (t) => {
  const h = await live(t, { transactions: [makeTx(1, { amount: '11.30', tax: { amount: '1.30', manual: true } })] });
  const r = await h.call('wave_get_transaction', { id: 'tx-1' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.sequence, 1);
  assert.equal(r.json.amount, '11.30');
  assert.equal(r.json.lines[0].salesTax[0].amount, '1.30');
  assert.equal(r.json.lines[0].salesTax[0].manual, true);
  assert.ok(r.json.editable.includes('canDelete'));
  const none = await h.call('wave_list_transactions', { search: 'no such thing' });
  assert.deepEqual([none.json.items, none.json.count, none.json.hasMore], [[], 0, false], 'empty result keeps items: []');
  const missing = await h.call('wave_get_transaction', { id: 'nope' });
  assert.match(missing.text, /not found/);
});

test('update: header fields send the current sequence; dryRun writes nothing', async (t) => {
  const h = await live(t);
  const dry = await h.call('wave_update_transaction', { id: 'tx-1', description: 'Renamed', dryRun: true });
  assert.equal(dry.json.dryRun, true);
  assert.equal(patches(h.internal).length, 0);
  const r = await h.call('wave_update_transaction', { id: 'tx-1', description: 'Renamed', notes: 'n', date: '2026-09-30' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(patches(h.internal)[0].variables.input, { id: 'tx-1', sequence: 1, date: '2026-09-30', description: 'Renamed', notes: 'n' });
  assert.equal(r.json.transaction.sequence, 2);
  const stale = await h.call('wave_update_transaction', { id: 'tx-1', notes: 'x', expectedSequence: 1 });
  assert.match(stale.text, /sequence 2, not 1/);
});

test('update: a concurrent edit (stale sequence) is reported, not retried', async (t) => {
  const h = await live(t);
  const realFetch = h.internal.fetchImpl;
  // Bump the sequence between our read and our write, as an edit in the web app would.
  h.internal.calls.length = 0;
  const original = h.internal.txs[0];
  const origGet = original.sequence;
  const r0 = await h.call('wave_get_transaction', { id: 'tx-1' });
  assert.equal(r0.json.sequence, origGet);
  h.ctx.internal.fetch = async (url, init) => {
    if (JSON.parse(init.body).query.includes('mutation TransactionPatch')) original.sequence += 1;
    return realFetch(url, init);
  };
  const r = await h.call('wave_update_transaction', { id: 'tx-1', notes: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /changed since it was read/);
  assert.equal(patches(h.internal).length, 1);
});

test('update: category, amount and vendor on a single-line transaction', async (t) => {
  const h = await live(t, { transactions: [makeTx(1, { amount: '11.30', category: ACC.uncat, tax: { amount: '1.30', manual: true } })] });
  const review = await h.call('wave_update_transaction', { id: 'tx-1', verified: true });
  assert.equal(review.isError, true);
  assert.match(review.text, /cannot be reviewed with uncategorized item/);

  const r = await h.call('wave_update_transaction', { id: 'tx-1', categoryId: ACC.marketing.id, amount: '22.60', vendorId: 'v-1', verified: true });
  assert.equal(r.isError, false, r.text);
  const input = patches(h.internal).at(-1).variables.input;
  assert.deepEqual(input.anchorLineItem, { order: 0, itemType: 'CREDIT', amount: '22.60', category: { type: 'ACCOUNT_ID', accountId: ACC.cash.id } });
  assert.deepEqual(input.lineItems, [{ order: 1, itemType: 'DEBIT', taxAction: 'PAYMENT', amount: '22.60', category: { type: 'ACCOUNT_ID', accountId: ACC.marketing.id }, vendorId: 'v-1' }]);
  assert.equal(input.verificationStatus, 'VERIFIED');
  assert.equal(r.json.transaction.lines[0].salesTax[0].amount, '1.30', 'manual tax kept');
  assert.match(r.json.warnings[0], /set manually/);

  const clear = await h.call('wave_update_transaction', { id: 'tx-1', vendorId: null });
  assert.equal(clear.isError, false, clear.text);
  assert.equal(patches(h.internal).at(-1).variables.input.lineItems[0].vendorId, null, 'null clears the vendor');
});

test('update: salesTax recalculates, sets or removes tax through Wave', async (t) => {
  const h = await live(t, { transactions: [makeTx(1, { amount: '22.60', tax: { amount: '1.30', manual: true } })] });
  const dry = await h.call('wave_update_transaction', { id: 'tx-1', salesTax: [{ salesTaxId: GST.id }], dryRun: true });
  assert.deepEqual(dry.json.salesTax, [{ line: 1, salesTax: [{ tax: 'GST', amount: '1.08' }] }]);
  const r = await h.call('wave_update_transaction', { id: 'tx-1', salesTax: [{ salesTaxId: GST.id }] });
  assert.deepEqual(patches(h.internal).at(-1).variables.input.lineItems[0].taxLiabilities, [{ accountId: GST.accountId }]);
  assert.equal(r.json.transaction.lines[0].salesTax[0].amount, '1.08');
  const manual = await h.call('wave_update_transaction', { id: 'tx-1', salesTax: [{ salesTaxId: GST.id, amount: 1 }] });
  assert.deepEqual(patches(h.internal).at(-1).variables.input.lineItems[0].taxLiabilities, [{ accountId: GST.accountId, amount: '1.00' }]);
  assert.equal(manual.json.transaction.lines[0].salesTax[0].manual, true);
  const none = await h.call('wave_update_transaction', { id: 'tx-1', salesTax: [] });
  assert.equal(none.json.transaction.lines[0].salesTax, undefined);
  const bad = await h.call('wave_update_transaction', { id: 'tx-1', salesTax: [{ salesTaxId: 'tax-unknown' }] });
  assert.match(bad.text, /not available in this business/);
});

test('update: split lines, balance check and line removal', async (t) => {
  const h = await live(t, { transactions: [makeTx(1, { amount: '22.60' })] });
  const unbalanced = await h.call('wave_update_transaction', { id: 'tx-1', lines: [{ order: 1, accountId: ACC.marketing.id, amount: '20' }, { accountId: ACC.uncat.id, amount: '5' }] });
  assert.match(unbalanced.text, /lines total 25.00 but the transaction amount is 22.60/);
  assert.equal(patches(h.internal).length, 0, 'checked locally first');

  const split = await h.call('wave_update_transaction', { id: 'tx-1', lines: [{ order: 1, accountId: ACC.marketing.id, amount: '17.35' }, { accountId: ACC.uncat.id, amount: '5.25', salesTax: [{ salesTaxId: GST.id }] }] });
  assert.equal(split.isError, false, split.text);
  const sent = patches(h.internal).at(-1).variables.input.lineItems;
  assert.equal(sent[1].order, undefined, 'new lines have no order');
  assert.equal(sent[1].itemType, 'DEBIT');
  assert.deepEqual(sent[1].taxLiabilities, [{ accountId: GST.accountId }]);
  assert.equal(split.json.transaction.lines.length, 2);
  assert.equal(split.json.transaction.lines[1].salesTax[0].amount, '0.25');

  const single = await h.call('wave_update_transaction', { id: 'tx-1', categoryId: ACC.uncat.id });
  assert.match(single.text, /2 category lines/);
  const mixed = await h.call('wave_update_transaction', { id: 'tx-1', categoryId: ACC.uncat.id, lines: [{ order: 1, accountId: ACC.marketing.id, amount: '22.60' }] });
  assert.match(mixed.text, /not both/);

  const merge = await h.call('wave_update_transaction', { id: 'tx-1', amount: '17.35', lines: [{ order: 1, accountId: ACC.marketing.id, amount: '17.35' }] });
  assert.equal(merge.isError, false, merge.text);
  assert.match(merge.json.warnings[0], /Removed 1 line/);
  assert.equal(merge.json.transaction.amount, '17.35');
});

test('update: Wave input errors are made readable', async (t) => {
  const h = await live(t);
  // Bypass the local balance check to see Wave's own answer.
  const realFetch = h.ctx.internal.fetch;
  h.ctx.internal.fetch = (url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.includes('mutation TransactionPatch')) body.variables.input.lineItems = [{ order: 1, amount: '10.5' }];
    return realFetch(url, { ...init, body: JSON.stringify(body) });
  };
  const r = await h.call('wave_update_transaction', { id: 'tx-1', categoryId: ACC.marketing.id });
  assert.equal(r.isError, true);
  assert.equal(r.text, 'Wave rejected the change: Line items are over balanced. (difference 0.50) [LINE_ITEM_AMOUNT_OVERBALANCED]');
});

test('delete: soft delete, then reads and repeats say it is gone', async (t) => {
  const h = await live(t);
  const r = await h.call('wave_delete_transaction', { id: 'tx-3' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(h.internal.calls.findLast((c) => c.name === 'TransactionDelete').variables.input, { id: 'tx-3', sequence: 1 });
  assert.match((await h.call('wave_get_transaction', { id: 'tx-3' })).text, /has been deleted/);
  assert.match((await h.call('wave_delete_transaction', { id: 'tx-3' })).text, /has been deleted/);
  assert.equal((await h.call('wave_list_transactions', { search: 'Purchase 3' })).json.items.some((x) => x.id === 'tx-3'), false);
});

test('read-only mode keeps list/get and hides edit/delete', async (t) => {
  const internal = createFakeInternal();
  const h = await connect(combineFakes(createFakeWave(), internal), { credentials: tempCredentials(BOTH), env: { WAVE_MCP_READ_ONLY: '1' } });
  t.after(h.close);
  const names = (await h.client.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes('wave_list_transactions') && names.includes('wave_get_transaction'));
  assert.ok(!names.includes('wave_update_transaction') && !names.includes('wave_delete_transaction'));
});

// ---------------------------------------------------------------- pure units

test('buildPatch refuses fields Wave marks as not editable', () => {
  const tx = makeTx(1);
  tx.detailActions.amount = false;
  assert.throws(() => buildPatch(tx, { amount: '5' }), /does not allow changing the amount/);
  assert.throws(() => buildPatch(tx, {}), /Nothing to change/);
  const { input, changed } = buildPatch(tx, { description: 'x' });
  assert.deepEqual(changed, ['description']);
  assert.deepEqual(input, { id: 'tx-1', sequence: 1, description: 'x' });
  assert.throws(() => buildPatch(tx, { lines: [{ order: 9, accountId: 'a', amount: '10' }] }), /order 9 is not a line/);
});

test('buildPatch handles journal entries (no bank side): lines only, debits = credits', () => {
  const tx = makeTx(1);
  tx.anchorLineItem = null;
  tx.direction = null;
  tx.lineItems = [
    { ...tx.lineItems[0], order: 0, itemType: 'DEBIT', amount: '5', taxAction: null },
    { ...tx.lineItems[0], order: 1, itemType: 'CREDIT', amount: '5', taxAction: null, account: ACC.uncat },
  ];
  assert.throws(() => buildPatch(tx, { amount: '7' }), /journal entry: it has no bank\/card side/);
  assert.throws(() => buildPatch(tx, { accountId: ACC.cash.id }), /journal entry/);
  assert.throws(() => buildPatch(tx, { categoryId: ACC.marketing.id }), /journal entry has 2 lines.*debits equal to credits/);
  assert.throws(() => buildPatch(tx, { lines: [{ order: 0, accountId: 'a', amount: '7' }, { order: 1, accountId: 'b', amount: '5' }] }), /Debits total 7.00 but credits total 5.00/);
  assert.throws(() => buildPatch(tx, { lines: [{ order: 0, accountId: 'a', amount: '5' }, { order: 1, accountId: 'b', amount: '4' }, { accountId: 'c', amount: '1' }] }), /give it a side/);
  const { input } = buildPatch(tx, { lines: [{ order: 0, accountId: 'a', amount: '7' }, { order: 1, accountId: 'b', amount: '5' }, { accountId: 'c', amount: '2', side: 'credit' }] });
  assert.equal(input.anchorLineItem, undefined);
  assert.deepEqual(input.lineItems[2], { itemType: 'CREDIT', taxAction: null, amount: '2.00', category: { type: 'ACCOUNT_ID', accountId: 'c' } });
});

test('dates must be real calendar dates', async (t) => {
  const h = await live(t);
  const r = await h.call('wave_list_transactions', { startDate: '2024-04-31' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Not a real calendar date/);
  assert.equal((await h.call('wave_list_transactions', { startDate: '2024-02-29' })).isError, false, 'leap day is fine');
});

test('describeInternalInputErrors digs the reason out of Wave\'s JSON strings', () => {
  assert.equal(describeInternalInputErrors([{ message: '' }, { message: '{"transactions": [{"__all__": ["Cannot do that."]}]}' }, { message: '400' }]), 'Cannot do that.');
  assert.equal(describeInternalInputErrors([{ message: '{"date": ["Enter a valid date."]}' }]), 'date: Enter a valid date.');
  assert.equal(describeInternalInputErrors([{ message: 'plain words', path: ['input', 'date'] }]), 'input.date: plain words');
  assert.equal(describeInternalInputErrors([{ code: 'INVALID', message: '' }]), 'no reason given (INVALID)');
});

// ---------------------------------------------------------------- login

const T = 'seqAbCdEf0123456789xyzXYZ0123';
test('extractCredential reads every DevTools copy format', () => {
  const pastes = {
    bash: `curl 'https://gql.waveapps.com/graphql/internal' \\\n  -H 'accept: */*' \\\n  -H 'authorization: Bearer ${T}' \\\n  -b 'a=b' \\\n  --data-raw '{"query":"q"}'`,
    cmd: `curl ^"https://gql.waveapps.com/graphql/internal^" ^\n  -H ^"authorization: Bearer ${T}^" ^\n  --data-raw ^"^{^\\^"q^\\^":1^}^"`,
    fetch: `fetch("https://gql.waveapps.com/graphql/internal", {\n  "headers": { "authorization": "Bearer ${T}" },\n  "method": "POST"\n});`,
    powershell: `$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession\nInvoke-WebRequest -UseBasicParsing -Uri "https://gql.waveapps.com/graphql/internal" \`\n-Headers @{\n"authorization"="Bearer ${T}"\n}`,
    headers: `POST /graphql/internal HTTP/2\nHost: gql.waveapps.com\nAuthorization: Bearer ${T}\nContent-Type: application/json`,
    bare: ` ${T}\n`,
  };
  for (const [kind, text] of Object.entries(pastes)) assert.equal(extractCredential(text).token, T, kind);
  assert.equal(extractCredential(pastes.bash).url, 'https://gql.waveapps.com/graphql/internal');
  assert.throws(() => extractCredential(`-H 'authorization: Bearer ${T}' -H 'authorization: Bearer ${T}x'`), /more than one/);
  assert.throws(() => extractCredential(`curl 'https://next.waveapps.com/' -H 'cookie: s=1'`), /cookies but no/);
  assert.throws(() => extractCredential('hello world'), /No "authorization/);
  assert.throws(() => extractCredential('   '), /Nothing was pasted/);
});

function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } });
  return { stream, get text() { return text; } };
}

function loginFetch(kind) {
  return async (url, init) => {
    const ok = init.headers.authorization === `Bearer ${T}`;
    const internal = String(url).includes('/internal');
    if (!ok || kind === 'expired') return Response.json({ errors: [{ message: 'expired', extensions: { code: 'UNAUTHENTICATED' } }], data: { user: null } });
    if (internal && kind === 'access') return Response.json({ errors: [{ message: 'API Application not approved for access.', extensions: { code: 'FORBIDDEN' } }], data: { user: null } });
    return Response.json({ data: { user: { firstName: 'Ada', lastName: 'Owner', defaultEmail: 'owner@example.com' } } });
  };
}

test('login stores a web session as WAVE_SESSION_TOKEN without printing it', async () => {
  const { file } = tempCredentials(`WAVE_ACCESS_TOKEN=${TOKEN}\n`);
  const out = sink();
  const err = sink();
  const config = loadConfig({ WAVE_CREDENTIALS_FILE: file });
  const code = await runLoginCli({ file, config, out: out.stream, err: err.stream, input: Readable.from([`curl 'https://gql.waveapps.com/graphql/internal' \\\n -H 'authorization: Bearer ${T}'\n`]), fetchImpl: loginFetch('session') });
  assert.equal(code, 0, err.text);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, new RegExp(`WAVE_SESSION_TOKEN=${T}`));
  assert.match(text, new RegExp(`WAVE_ACCESS_TOKEN=${TOKEN}`), 'other keys kept');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(out.text, /Signed in as Ada Owner/);
  assert.match(out.text, /keeps using your stored API token/);
  assert.ok(!(out.text + err.text).includes(T), 'token never printed');
});

test('login recognizes a public API token and rejects expired ones', async () => {
  const { file } = tempCredentials(null);
  const config = loadConfig({ WAVE_CREDENTIALS_FILE: file });
  const out = sink();
  const code = await runLoginCli({ file, config, out: out.stream, err: sink().stream, input: Readable.from([`${T}\n`]), fetchImpl: loginFetch('access') });
  assert.equal(code, 0);
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`^WAVE_ACCESS_TOKEN=${T}$`, 'm'));
  assert.match(out.text, /public API token/);

  const { file: f2 } = tempCredentials(null);
  const err = sink();
  const bad = await runLoginCli({ file: f2, config, out: sink().stream, err: err.stream, input: Readable.from([`${T}\n`]), fetchImpl: loginFetch('expired') });
  assert.equal(bad, 1);
  assert.match(err.text, /expired or signed out/);
  assert.equal(fs.existsSync(f2), false, 'nothing written');
});

test('summarize adds up every page by category and month, counting only the filtered lines of splits', async (t) => {
  const rent = { id: 'acct-rent', name: 'Rent' };
  const split = makeTx(140, { date: '2026-09-15', amount: '150.00', description: 'Split purchase' });
  split.lineItems = [
    { ...split.lineItems[0], order: 1, amount: '100', account: rent, taxSummary: { totalTaxAmount: '4.76', taxLiabilities: [] } },
    { ...split.lineItems[0], order: 2, amount: '50', account: ACC.marketing },
  ];
  const refund = makeTx(141, { date: '2026-09-20', amount: '20.00', description: 'Refund' });
  refund.direction = 'DEPOSIT';
  refund.anchorLineItem.itemType = 'DEBIT';
  refund.lineItems[0].itemType = 'CREDIT';
  const txs = [...Array.from({ length: 130 }, (_, i) => makeTx(i + 1, { date: `2026-${String(1 + (i % 8)).padStart(2, '0')}-10` })), split, refund];
  const h = await live(t, { transactions: txs });

  const all = await h.call('wave_summarize_transactions', { groupBy: 'month' });
  assert.equal(all.isError, false, all.text);
  assert.equal(all.json.matched, 132);
  assert.deepEqual(all.json.totals, { currency: 'CAD', transactions: 132, withdrawals: '1450.00', deposits: '20.00', net: '-1430.00', salesTaxPaid: '4.76' });
  assert.equal(all.json.groups[0].month, '2026-01');
  assert.equal(all.json.groups.at(-1).month, '2026-09');
  assert.equal(h.internal.calls.filter((c) => c.name === 'ListTransactions').length, 2, 'paged 100 at a time');

  const rentOnly = await h.call('wave_summarize_transactions', { categoryIds: ['acct-rent'] });
  assert.deepEqual(rentOnly.json.groups, [{ category: 'Rent', transactions: 1, withdrawals: '100.00', deposits: '0.00', net: '-100.00', salesTaxPaid: '4.76' }]);
  assert.equal(rentOnly.json.totals.withdrawals, '100.00', 'the marketing half of the split is not counted');

  const capped = await h.call('wave_summarize_transactions', { groupBy: 'month', maxGroups: 3 });
  assert.equal(capped.json.groups.length, 3);
  assert.equal(capped.json.otherGroups.groups, 6);

  const none = await h.call('wave_summarize_transactions', { groupBy: 'none', search: 'nothing like this' });
  assert.equal(none.json.matched, 0);
  assert.equal(none.json.groups, undefined);
  assert.match(none.json.notes[0], /No transactions matched/);
});

test('an expense category passed as accountId is used as a category filter, with a note', async (t) => {
  const rent = { id: 'acct-rent', name: 'Rent' };
  const h = await live(t, { transactions: [makeTx(1, { category: rent }), makeTx(2)] });
  const r = await h.call('wave_list_transactions', { accountId: 'acct-rent' });
  assert.equal(r.json.count, 1);
  assert.deepEqual(r.json.filters.categoryIds, ['acct-rent']);
  assert.equal(r.json.filters.anchorId, undefined);
  assert.match(r.json.notes[0], /Rent is an expense category, so it was used as categoryIds/);
  const bank = await h.call('wave_list_transactions', { accountId: 'acct-bank' });
  assert.equal(bank.json.filters.anchorId, 'acct-bank', 'bank accounts stay an account filter');
  assert.equal(bank.json.notes, undefined);
});

test('rows and lines show when Wave guessed the category and nobody approved it', async (t) => {
  const h = await live(t, {
    transactions: [
      makeTx(1, { autocat: 'NOT_APPROVED' }),
      makeTx(2, { autocat: 'APPROVED', verified: true }),
      makeTx(3),
    ],
  });
  const r = await h.call('wave_list_transactions', { sort: 'date_asc' });
  assert.equal(r.isError, false, r.text);
  const byId = Object.fromEntries(r.json.items.map((i) => [i.id, i]));
  assert.equal(byId['tx-1'].autoCategory, 'not_approved');
  assert.equal(byId['tx-2'].autoCategory, 'approved');
  assert.equal('autoCategory' in byId['tx-3'], false, 'absent when Wave did not guess');

  const g = await h.call('wave_get_transaction', { id: 'tx-1' });
  assert.equal(g.isError, false, g.text);
  assert.equal(g.json.lines[0].autoCategory, 'not_approved');
  assert.equal(g.json.anchor.autoCategory, undefined);
});

const transferPair = () => [
  makeTx(1, { date: '2026-11-17', description: 'Card payment', amount: '125.00', category: ACC.uncat, autocat: 'NOT_APPROVED' }),
  makeTx(2, { date: '2026-11-18', description: 'Payment received', amount: '125.00', category: ACC.uncatIncome, anchor: ACC.card, direction: 'DEPOSIT' }),
  makeTx(3, { date: '2026-11-18', description: 'Other card refund', amount: '20.00', anchor: ACC.card, direction: 'DEPOSIT' }),
];

test('find transfer matches: asks Wave as the web app does and shows each candidate', async (t) => {
  const h = await live(t, { transactions: transferPair() });
  const r = await h.call('wave_find_transfer_matches', { id: 'tx-1' });
  assert.equal(r.isError, false, r.text);
  const sent = h.internal.calls.find((c) => c.name === 'TransactionCategories').variables;
  assert.deepEqual(sent.input, {
    transactionDate: '2026-11-17',
    direction: 'WITHDRAWAL',
    transactionType: 'ANCHOR',
    lineItemCategory: { type: 'ACCOUNT_ID', accountId: ACC.uncat.id },
    anchorId: ACC.cash.id,
    anchorItemType: 'CREDIT',
    isTransactionMultiLine: false,
    transactionAmount: '125.00',
    lineItemItemType: 'DEBIT',
    groupFilter: 'TRANSFER_CATEGORY_SUBGROUP',
  });
  assert.equal(r.json.matches.length, 1);
  assert.equal(r.json.matches[0].id, 'tx-2');
  assert.equal(r.json.matches[0].account, 'Visa');
  assert.equal(r.json.matches[0].daysApart, 1);
  assert.deepEqual(r.json.createTransferAccounts.map((a) => a.name), ['Visa', 'Equipment Loan']);
  assert.match(r.json.note, /^wave_match_transfer records/);
  assert.equal(patches(h.internal).length, 0);

  const none = await h.call('wave_find_transfer_matches', { id: 'tx-3' });
  assert.ok(!none.json.matches?.length);
  assert.match(none.json.note, /no matching transaction.*wave_create_transfer records/);
  assert.equal(none.json.matchesFound, 0);
});

test('match transfer: dry run, then the web app patch, and both sides become a transfer', async (t) => {
  const h = await live(t, { transactions: transferPair() });
  const dry = await h.call('wave_match_transfer', { id: 'tx-1', matchId: 'tx-2', dryRun: true });
  assert.equal(dry.isError, false, dry.text);
  assert.equal(dry.json.dryRun, true);
  assert.deepEqual(dry.json.input, { id: 'tx-1', sequence: 1, errorIfReconciliationIsImpacted: true, lineItems: [{ order: 1, category: { type: 'MATCHING_TRANSFER', transactionId: 'tx-2', transactionSequence: 1, lineItemOrder: 1 } }] });
  assert.deepEqual(dry.json.categoriesReplaced.map((c) => c.category), ['Uncategorized Expense', 'Uncategorized Income']);
  assert.equal(patches(h.internal).length, 0, 'dry run saves nothing');

  const r = await h.call('wave_match_transfer', { id: 'tx-1', matchId: 'tx-2' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.matched.map((s) => s.category), ['Transfer Clearing', 'Transfer Clearing']);
  assert.deepEqual(r.json.matched.map((s) => s.sequence), [2, 2]);
  assert.equal(patches(h.internal).length, 1);

  const again = await h.call('wave_match_transfer', { id: 'tx-1', matchId: 'tx-2' });
  assert.equal(again.isError, true);
  assert.match(again.text, /already one side of a transfer/);
});

test('match transfer refuses pairs that are not a transfer', async (t) => {
  const txs = [
    ...transferPair(),
    makeTx(4, { date: '2026-11-17', description: 'Same account deposit', amount: '125.00', direction: 'DEPOSIT' }),
    makeTx(5, { date: '2026-11-18', description: 'Reconciled payment', amount: '50.00', anchor: ACC.card, direction: 'DEPOSIT', reconciled: true }),
    makeTx(6, { date: '2026-11-17', description: 'Transfer out', amount: '50.00' }),
    makeTx(7, { date: '2026-11-17', description: 'Withdrawal on card', amount: '125.00', anchor: ACC.card }),
    makeTx(8, { date: '2026-12-30', description: 'Late payment', amount: '125.00', anchor: ACC.card, direction: 'DEPOSIT' }),
  ];
  const h = await live(t, { transactions: txs });
  const cases = [
    [{ id: 'tx-1', matchId: 'tx-1' }, /itself/],
    [{ id: 'tx-1', matchId: 'tx-4' }, /same account/],
    [{ id: 'tx-1', matchId: 'tx-3' }, /amounts differ/],
    [{ id: 'tx-1', matchId: 'tx-7' }, /both transactions are withdrawals/],
    [{ id: 'tx-6', matchId: 'tx-5' }, /reconciled/],
    [{ id: 'tx-1', matchId: 'tx-8' }, /does not list/],
  ];
  for (const [args, re] of cases) {
    const r = await h.call('wave_match_transfer', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re, JSON.stringify(args));
  }
  assert.equal(patches(h.internal).length, 0);
});

test('create transfer: a loan payment with no other side, after Wave\'s reconciliation check', async (t) => {
  const loanPayment = makeTx(1, { date: '2026-11-04', description: 'Loan payment', amount: '75.00', category: ACC.uncat });
  const h = await live(t, { transactions: [loanPayment] });
  const dry = await h.call('wave_create_transfer', { id: 'tx-1', accountId: ACC.loan.id, dryRun: true });
  assert.equal(dry.isError, false, dry.text);
  assert.deepEqual(dry.json.input.lineItems[0].category, { type: 'CREATE_TRANSFER', accountId: ACC.loan.id });
  assert.equal(dry.json.to, 'Equipment Loan');
  assert.deepEqual(h.internal.calls.find((c) => c.name === 'DoesImpactReconciliation').variables.changes, [{ accountId: ACC.loan.id, transactionDate: '2026-11-04' }]);
  assert.equal(patches(h.internal).length, 0, 'dry run saves nothing');

  const r = await h.call('wave_create_transfer', { id: 'tx-1', accountId: ACC.loan.id });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.transaction.category, 'Transfer Clearing');
  assert.equal(r.json.otherSide.account, 'Equipment Loan');
  assert.equal(r.json.otherSide.direction, 'deposit');
  assert.deepEqual(patches(h.internal)[0].variables.input, { id: 'tx-1', sequence: 1, errorIfReconciliationIsImpacted: true, lineItems: [{ order: 1, category: { type: 'CREATE_TRANSFER', accountId: ACC.loan.id }, taxAction: null }] }, 'the web app\'s patch, nulls kept');
});

test('create transfer refuses a duplicate side, an account Wave does not offer, and reconciled periods', async (t) => {
  const h = await live(t, { transactions: transferPair(), reconciledAccounts: [ACC.loan.id] });
  const cases = [
    [{ id: 'tx-1', accountId: ACC.card.id }, /already lists tx-2 .* wave_match_transfer/],
    [{ id: 'tx-1', accountId: ACC.cash.id }, /already in/],
    [{ id: 'tx-1', accountId: ACC.marketing.id }, /does not offer/],
    [{ id: 'tx-1', accountId: ACC.loan.id, dryRun: true }, /reconciled statement period/],
  ];
  for (const [args, re] of cases) {
    const r = await h.call('wave_create_transfer', args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, re, JSON.stringify(args));
  }
  assert.equal(patches(h.internal).length, 0);
});

test('export: every matching transaction goes to a file, only a summary comes back', async (t) => {
  const os = await import('node:os');
  const path = await import('node:path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-mcp-export-'));
  const txs = [
    ...Array.from({ length: 230 }, (_, i) => makeTx(i + 1, { date: `2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`, description: i === 0 ? '=HYPERLINK("x")' : `Purchase, "${i + 1}"`, amount: '10.00', autocat: i % 2 ? 'NOT_APPROVED' : null })),
    makeTx(999, { date: '2026-10-01', amount: '5.00', anchor: ACC.card, direction: 'DEPOSIT', category: ACC.sales }),
  ];
  const internal = createFakeInternal({ transactions: txs });
  const h = await connect(combineFakes(createFakeWave(), internal), { credentials: tempCredentials(BOTH), env: { WAVE_BUSINESS_ID: BUSINESS.id, WAVE_MCP_DATA_DIR: dataDir, WAVE_MCP_READ_ONLY: '1' } });
  t.after(h.close);

  const r = await h.call('wave_export_transactions', { fileName: 'all-2026' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.rows, 231);
  assert.equal(r.json.path, path.join(dataDir, 'exports', 'all-2026.csv'));
  assert.deepEqual(r.json.totals, { deposits: '5.00', withdrawals: '2300.00' });
  assert.ok(r.text.length < 1000, 'no rows in the response');
  assert.equal(fs.statSync(r.json.path).mode & 0o777, 0o600);
  const lines = fs.readFileSync(r.json.path, 'utf8').trimEnd().split('\r\n');
  assert.equal(lines.length, 232);
  assert.match(lines[0], /^id,date,description,amount,direction,account,accountId,category,categoryId,lines,transfer,autoCategory/);
  assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""x"")"`)), 'formula text is defused and quoted');
  assert.ok(lines.some((l) => l.startsWith('tx-2,') && l.includes('"Purchase, ""2"""') && l.includes(',not_approved,')));
  assert.equal(internal.calls.filter((c) => c.name === 'TransactionPatch').length, 0);

  const j = await h.call('wave_export_transactions', { format: 'jsonl', accountId: ACC.card.id, fileName: 'card' });
  assert.equal(j.json.rows, 1);
  const row = JSON.parse(fs.readFileSync(j.json.path, 'utf8').trim());
  assert.deepEqual([row.id, row.direction, row.account, row.category, row.transfer], ['tx-999', 'deposit', 'Visa', 'Sales', false]);

  const capped = await h.call('wave_export_transactions', { maxRows: 50, fileName: 'capped', format: 'jsonl' });
  assert.equal(capped.json.rows, 50);
  assert.match(capped.json.truncated, /maxRows/);

  const again = await h.call('wave_export_transactions', { fileName: 'all-2026' });
  assert.equal(again.isError, true);
  assert.match(again.text, /already exists/);
  for (const bad of ['../escape', 'sub/dir', '/etc/passwd', '.hidden', 'a\\b']) {
    const x = await h.call('wave_export_transactions', { fileName: bad });
    assert.equal(x.isError, true, bad);
    assert.match(x.text, /plain file name/, bad);
  }
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'exports')).sort(), ['all-2026.csv', 'capped.jsonl', 'card.jsonl']);
});
