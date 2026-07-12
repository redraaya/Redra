import { app } from 'electron';
import { validateOp } from './lib/validate-op.js';
import type { OpenedDoc } from './document-manager.js';
import type { PerfLog } from './lib/perf.js';

/**
 * Smoke-run harness (`electron . --smoke file.html`): the run only succeeds
 * once BOTH the document was served AND the doc preload reported the editing
 * layer alive ('doc:editorReady'). On success the perf lines are logged and
 * the app exits 0; any missing piece exits 1 so CI never hangs.
 *
 * Log strings are part of the CI contract — never reword them.
 */
export class SmokeHarness {
  private servedAt: number | null = null;
  private editorReady = false;
  private finished = false;

  constructor(
    private readonly active: boolean,
    private readonly perf: PerfLog,
    /** Smoke drives a single window — the first context's open document. */
    private readonly getDoc: () => OpenedDoc | null,
  ) {}

  /** True when the app runs with --smoke. */
  get enabled(): boolean {
    return this.active;
  }

  /** Call once app startup finished opening (or failing to open) the CLI file. */
  onReady(hasInput: boolean): void {
    if (!this.active) return;
    if (!hasInput) {
      console.error('[smoke] no input file given');
      app.exit(1);
      return;
    }
    // Fail-safe: never hang CI.
    setTimeout(() => {
      console.error('[smoke] timed out');
      app.exit(1);
    }, 20_000);
  }

  /** The document was served over redra:// — half of the success gate. */
  onServed(filePath: string): void {
    if (!this.active) return;
    console.log('[smoke] document served:', filePath);
    this.servedAt = performance.now();
    this.maybeFinish();
    // The editing layer must report in — a dead doc preload is a failed run.
    setTimeout(() => {
      if (!this.finished) {
        console.error('[smoke] FAILED: doc preload never reported editorReady');
        app.exit(1);
      }
    }, 5000);
  }

  /**
   * Liveness beacon from the doc preload arrived. Outside smoke runs this is
   * a no-op datapoint (servedAt is never set), in smoke runs it records the
   * serve→ready latency and completes the gate.
   */
  onEditorReady(): void {
    if (this.servedAt !== null) {
      this.perf.record('serve-to-editor-ready', performance.now() - this.servedAt);
    }
    this.editorReady = true;
    this.maybeFinish();
  }

  private maybeFinish(): void {
    if (!this.active || this.finished || this.servedAt === null || !this.editorReady) return;
    this.finished = true;
    for (const e of this.perf.all()) {
      console.log(`[smoke] perf ${e.name} = ${e.ms}ms`, e.detail ?? '');
    }
    this.opsRoundtrip();
    console.log('[smoke] editor ready — OK');
    setTimeout(() => app.exit(0), 100);
  }

  /** SMOKE-mode self-check: validation + journal round-trip on the real doc. */
  private opsRoundtrip(): void {
    const cur = this.getDoc();
    if (!cur) return;
    // The self-check op is format-shaped: HTML stamps are "r<n>" and go
    // through validateOp; Markdown stamps are "m<n>" (validated elsewhere).
    let op: { type: 'editText'; id: string; html: string };
    if (cur.format === 'md') {
      op = { type: 'editText', id: 'm0', html: 'smoke' };
    } else {
      const checked = validateOp({ type: 'editText', id: 'r1', html: '<b>smoke</b>' }, cur.doc);
      if (!checked.ok) {
        console.error('[smoke] ops-roundtrip FAILED: validateOp:', checked.error);
        app.exit(1);
        return;
      }
      op = checked.op as typeof op;
    }
    cur.journal.push(op);
    const dirtyAfterPush = cur.journal.dirty;
    cur.journal.undo();
    if (!dirtyAfterPush || cur.journal.dirty) {
      console.error('[smoke] ops-roundtrip FAILED: dirty flags wrong');
      app.exit(1);
      return;
    }
    console.log('[smoke] ops-roundtrip OK');
  }
}
