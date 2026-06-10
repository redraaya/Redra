/**
 * Sender-validation helper for IPC handlers.
 *
 * Every handler must verify the event really came from the WebContents the
 * channel belongs to (shell channels from the shell window, doc channels
 * from the document view) — a compromised or simply confused renderer must
 * not be able to drive the other side's API.
 *
 * Kept Electron-free (structural typing) so it is unit-testable.
 */
export function senderMatches(event: { sender: unknown }, expected: unknown): boolean {
  return expected !== null && expected !== undefined && event.sender === expected;
}
