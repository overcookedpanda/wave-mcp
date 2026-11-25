import fs from 'node:fs';
import path from 'node:path';

/**
 * Exports live in <data dir>/exports, mode 700, one file per export, mode 600
 * (they hold the books). Only a plain file name is accepted, so an export can
 * never be written anywhere else. Writes are atomic.
 */
export const exportDir = (dataDir) => path.join(dataDir, 'exports');

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function exportPath(dataDir, fileName, ext) {
  if (!SAFE_NAME.test(fileName) || fileName.includes('..')) {
    throw new Error(`fileName must be a plain file name (letters, digits, dot, dash, underscore; no folders): ${JSON.stringify(fileName)}`);
  }
  const name = fileName.endsWith(`.${ext}`) ? fileName : `${fileName}.${ext}`;
  return path.join(exportDir(dataDir), name);
}

export function writeExport(file, content, { overwrite = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!overwrite && fs.existsSync(file)) {
    throw Object.assign(new Error(`${path.basename(file)} already exists in the exports folder. Pass overwrite: true or another fileName.`), { code: 'EEXIST' });
  }
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * One CSV cell (RFC 4180). Text that a spreadsheet would run as a formula
 * (starting with = + - @, tab or carriage return) gets a leading apostrophe;
 * numbers are written as they are.
 */
export function csvCell(value, { text = false } = {}) {
  if (value === undefined || value === null) return '';
  let s = String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
