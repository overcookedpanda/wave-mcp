import os from 'node:os';
import path from 'node:path';

export const DEFAULT_API_URL = 'https://gql.waveapps.com/graphql/public';
export const DEFAULT_OAUTH_BASE_URL = 'https://api.waveapps.com/oauth2';
/** The API Wave's own web app uses (unofficial; needs a web session token). */
export const DEFAULT_INTERNAL_API_URL = 'https://gql.waveapps.com/graphql/internal';

export const TOOLSETS = [
  'context',
  'customers',
  'vendors',
  'products',
  'accounts',
  'sales_taxes',
  'invoices',
  'estimates',
  'payments',
  'transactions',
  'ledger',
  'reports',
  'graphql',
];

/**
 * Credentials may only ever be sent to Wave. Every endpoint, including any
 * override from the environment, must be https on waveapps.com or one of its
 * subdomains, with no port or userinfo.
 */
const WAVE_HOST = /(^|\.)waveapps\.com$/i;

export function pinnedWaveUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (url.protocol !== 'https:' || !WAVE_HOST.test(url.hostname) || url.port || url.username || url.password) {
    throw new Error(`${name} must be an https URL on waveapps.com (got "${url.protocol}//${url.host}"). Credentials are only sent to Wave.`);
  }
  return value;
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim());

function int(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function list(value) {
  if (!value) return null;
  const items = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

/** Imported ledgers (financial data, not secrets). */
export function defaultDataDir(env = process.env) {
  if (env.WAVE_MCP_DATA_DIR) return env.WAVE_MCP_DATA_DIR;
  const base = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'wave-mcp');
}

export function defaultCredentialsFile(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'wave-mcp', 'credentials.env');
}

/**
 * Non-secret runtime settings. Secrets live in the credentials file (see
 * auth/credentials.js) and never in this object.
 */
export function loadConfig(env = process.env) {
  const toolsets = list(env.WAVE_MCP_TOOLSETS);
  const unknown = toolsets?.filter((t) => t !== 'all' && !TOOLSETS.includes(t)) ?? [];
  if (unknown.length) {
    throw new Error(`Unknown WAVE_MCP_TOOLSETS value(s): ${unknown.join(', ')}. Valid: all, ${TOOLSETS.join(', ')}`);
  }
  return {
    credentialsFile: env.WAVE_CREDENTIALS_FILE || defaultCredentialsFile(env),
    dataDir: defaultDataDir(env),
    apiUrl: pinnedWaveUrl(env.WAVE_API_URL || DEFAULT_API_URL, 'WAVE_API_URL'),
    internalApiUrl: pinnedWaveUrl(env.WAVE_INTERNAL_API_URL || DEFAULT_INTERNAL_API_URL, 'WAVE_INTERNAL_API_URL'),
    oauthBaseUrl: pinnedWaveUrl(env.WAVE_OAUTH_BASE_URL || DEFAULT_OAUTH_BASE_URL, 'WAVE_OAUTH_BASE_URL').replace(/\/+$/, ''),
    businessId: env.WAVE_BUSINESS_ID || undefined,
    readOnly: truthy(env.WAVE_MCP_READ_ONLY),
    // Off by default in this fork: tools that email customers.
    allowEmail: truthy(env.WAVE_MCP_ALLOW_EMAIL),
    // Off by default in this fork: changing a transaction's date, description,
    // bank/card account, amount or journal lines, and deleting transactions.
    // Categorizing (category, splits that keep the total, vendor/customer,
    // sales tax, notes, reviewed) stays available.
    allowLedgerEdits: truthy(env.WAVE_MCP_ALLOW_LEDGER_EDITS),
    toolsets: !toolsets || toolsets.includes('all') ? [...TOOLSETS] : toolsets,
    maxConcurrency: int(env.WAVE_MCP_MAX_CONCURRENCY, 2, { max: 8 }),
    requestTimeoutMs: int(env.WAVE_MCP_TIMEOUT_MS, 30_000, { min: 1000 }),
    maxRetries: int(env.WAVE_MCP_MAX_RETRIES, 3, { min: 0, max: 8 }),
    maxResponseChars: int(env.WAVE_MCP_MAX_RESPONSE_CHARS, 60_000, { min: 4000 }),
    scanLimit: int(env.WAVE_MCP_SCAN_LIMIT, 5000, { min: 100 }),
    cacheTtlMs: int(env.WAVE_MCP_CACHE_TTL_MS, 120_000, { min: 0 }),
    logLevel: env.WAVE_MCP_LOG_LEVEL || 'info',
    http: {
      host: env.WAVE_MCP_HTTP_HOST || '127.0.0.1',
      port: int(env.WAVE_MCP_HTTP_PORT, 8787, { min: 1, max: 65535 }),
      path: env.WAVE_MCP_HTTP_PATH || '/mcp',
      allowedHosts: list(env.WAVE_MCP_ALLOWED_HOSTS),
    },
  };
}
