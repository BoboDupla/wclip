import { createInterface } from 'node:readline';

export class WclipError extends Error {}

// $WCLIP_<name>, e.g. $WCLIP_CONFIG to point at another config file.
export function envVar(name: string): string | undefined {
  return process.env[`WCLIP_${name}`] || undefined;
}

// Diagnostics go to stderr so --stdout emits only the note.
export function die(msg: string): never {
  throw new WclipError(msg);
}
// Keep intended line breaks/tabs in diagnostics, but strip terminal controls and OSC/CSI introducers.
export function terminalText(msg: string): string {
  return String(msg).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}
export function warn(msg: string): void {
  process.stderr.write(`warning: ${terminalText(msg)}\n`);
}
export function info(msg: string): void {
  process.stderr.write(`${terminalText(msg)}\n`);
}

// One shared line reader: a fresh readline per question would swallow the rest of piped input.
let lines: AsyncIterator<string> | null = null;

export async function ask(label: string, def = ''): Promise<string> {
  process.stderr.write(terminalText(`${label}${def ? ` [${def}]` : ''}: `));
  lines ??= createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
  const next = await lines.next();
  if (next.done) process.stderr.write('\n'); // EOF: take the default
  return (next.done ? '' : next.value.trim()) || def;
}

export function closeInput(): void {
  void lines?.return?.();
  lines = null;
}

// Word characters: letters, digits and underscore, in any script.
const W = String.raw`[\p{L}\p{N}_]`;

export function sanitizeFilename(title: string): string {
  let t = title.toLowerCase();
  t = t.replace(/[^\p{L}\p{N}_\s-]/gu, '');
  t = t.replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');
  // Leave room for collision suffixes and extensions under Linux NAME_MAX (255 bytes).
  let out = '';
  let bytes = 0;
  for (const c of t) {
    const n = Buffer.byteLength(c);
    if (bytes + n > 200) break;
    out += c; bytes += n;
  }
  return out.replace(/^-+|-+$/g, '') || 'untitled';
}

export function wordCount(text: string): number {
  // Strip markdown links/images so URLs aren't counted as words.
  text = text.replace(/!?\[\]\([^)]*\)/g, '');
  text = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  return (text.match(new RegExp(`${W}(?:[\\p{L}\\p{N}_'-]*${W})?`, 'gu')) ?? []).length;
}

export function readingTime(words: number, wpm: number): string {
  return `${Math.max(1, Math.ceil(words / Math.max(1, wpm)))} min`;
}

export function normalizeTag(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// YYYY-MM-DD from an ISO-ish date; other formats ("July 28, 2025") via Date.parse.
export function parseDate(s: string | undefined | null): string {
  s = (s ?? '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  if (!s) return '';
  const t = Date.parse(s);
  if (Number.isNaN(t)) return '';
  // Local calendar date of the parsed string, not UTC, so "July 28" stays the 28th.
  return localDate(new Date(t));
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function today(): string {
  return localDate(new Date());
}

export function hostOf(url: string): string {
  return new URL(url).hostname.replace(/^www\./, '');
}

export function normalizeUrl(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}
