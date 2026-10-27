// Progress reporting. Everything goes to stderr (so --stdout stays byte-clean), and the live
// line is drawn only when stderr is a terminal: pipes, logs and CI get plain lines instead.
// Frames are ASCII on purpose; the terminal may be xterm.js with a font that lacks braille.
import { envVar } from './util.js';

const CLEAR = '\r\x1b[2K';
const FRAMES = ['|', '/', '-', '\\'];
const TICK_MS = 120;
const BAR_WIDTH = 16;

let verbose = false;
let quiet = false;
let animate = stderrIsTty() && envVar('PROGRESS') !== '0';

function stderrIsTty(): boolean {
  return Boolean(process.stderr.isTTY) && process.env.TERM !== 'dumb';
}

export interface StatusSettings {
  verbose?: boolean;
  quiet?: boolean;
  progress?: boolean; // false: never animate; true: animate when stderr is a terminal
}

export function configureStatus(s: StatusSettings): void {
  if (s.verbose !== undefined) verbose = s.verbose;
  if (s.quiet !== undefined) quiet = s.quiet;
  if (s.progress !== undefined) animate = s.progress && stderrIsTty() && envVar('PROGRESS') !== '0';
}

export const isVerbose = (): boolean => verbose;
export const isQuiet = (): boolean => quiet;

// Plain info line that --quiet hides; the result lines use info() directly.
export function note(msg: string): void {
  if (!quiet) process.stderr.write(`${msg}\n`);
}

export function formatBytes(n: number): string {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 10000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`;
}

export function renderBar(done: number, total: number, width = BAR_WIDTH): string {
  if (total <= 0) return '';
  const n = Math.min(width, Math.max(0, Math.round((width * done) / total)));
  return `[${'#'.repeat(n)}${'-'.repeat(width - n)}]`;
}

export interface Task {
  setDetail(detail: string): void;
  progress(done: number, total: number, what?: string): void;
  done(msg?: string): void;
  fail(): void;
}

const NOOP: Task = { setDetail() {}, progress() {}, done() {}, fail() {} };

let active: Task | null = null;

class LiveTask implements Task {
  private readonly start = Date.now();
  private detail = '';
  private counter = '';
  private frame = 0;
  private drawn = false;
  private finished = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly label: string) {
    if (animate) {
      // Paint straight away: a page that extracts in 200 ms would otherwise never show a frame.
      this.paint();
      this.timer = setInterval(() => { this.frame++; this.paint(); }, TICK_MS);
      this.timer.unref();
    } else {
      process.stderr.write(`${label} ...\n`);
    }
  }

  private paint(): void {
    if (this.finished) return;
    const c = (process.stderr as NodeJS.WriteStream & { columns?: number }).columns;
    const cols = (c && c > 20 ? c : 100) - 1;
    const right = this.counter || formatDuration(Date.now() - this.start);
    const head = `${FRAMES[this.frame % FRAMES.length]} ${this.label}${this.detail ? ` (${this.detail})` : ''}`;
    const room = Math.max(10, cols - right.length - 1);
    const left = head.length > room ? `${head.slice(0, room - 3)}...` : head;
    const gap = Math.max(1, cols - left.length - right.length);
    process.stderr.write(`${CLEAR}${left}${' '.repeat(gap)}${right}`);
    this.drawn = true;
  }

  setDetail(detail: string): void {
    this.detail = detail;
    if (animate) this.paint();
    else process.stderr.write(`  ${detail}\n`);
  }

  progress(done: number, total: number, what = ''): void {
    this.counter = `${what ? `${what} ` : ''}${renderBar(done, total)} ${done}/${total}`;
    if (animate && !this.drawn) this.paint();
  }

  done(msg?: string): void {
    if (this.finished) return;
    this.stop();
    if (msg) process.stderr.write(`ok ${msg} in ${formatDuration(Date.now() - this.start)}\n`);
  }

  fail(): void {
    this.stop();
  }

  private stop(): void {
    this.finished = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (animate && this.drawn) process.stderr.write(CLEAR);
    if (active === this) active = null;
  }
}

export function startTask(label: string): Task {
  if (quiet || !process.stderr.writable) return NOOP;
  const t = new LiveTask(label);
  active = t;
  return t;
}

// Clear a line left mid-draw (SIGINT, fatal error) so the message that follows is not mangled.
export function stopStatus(): void {
  active?.fail();
  active = null;
}
