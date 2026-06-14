/**
 * Session-scoped cache for the last thinking header values seen during streaming.
 *
 * The persisted thinking message that replaces the streaming one has a different
 * id and may arrive without duration/token metadata. This cache lets the final
 * header keep the exact last streamed value without any post-stream updates.
 */

type ThinkingHeader = {
  duration?: number;
  tokens?: number;
};

const cache = new Map<string, ThinkingHeader>();

export function getThinkingHeaderCache(sessionId: string | null | undefined): ThinkingHeader | undefined {
  if (!sessionId) return undefined;
  return cache.get(sessionId);
}

export function setThinkingHeaderCache(
  sessionId: string | null | undefined,
  header: ThinkingHeader,
): void {
  if (!sessionId) return;
  cache.set(sessionId, header);
}

export function clearThinkingHeaderCache(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  cache.delete(sessionId);
}
