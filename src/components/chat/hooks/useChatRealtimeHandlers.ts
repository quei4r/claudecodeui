import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { usePaletteOps } from '../../../contexts/PaletteOpsContext';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { showCompletionTitleIndicator } from '../../../utils/pageTitleNotification';
import { playChatCompletionSound } from '../../../utils/notificationSound';
import {
  clearThinkingHeaderCache,
  getThinkingHeaderCache,
  setThinkingHeaderCache,
} from '../utils/thinkingHeaderCache';
import type { PendingPermissionRequest, SessionNavigationOptions } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';

type PendingViewSession = {
  startedAt: number;
};

type LatestChatMessage = {
  type?: string;
  kind?: string;
  data?: any;
  message?: any;
  delta?: string;
  sessionId?: string;
  session_id?: string;
  requestId?: string;
  toolName?: string;
  input?: unknown;
  context?: unknown;
  error?: string;
  tool?: any;
  toolId?: string;
  result?: any;
  exitCode?: number;
  isProcessing?: boolean;
  actualSessionId?: string;
  event?: string;
  status?: any;
  isNewSession?: boolean;
  resultText?: string;
  isError?: boolean;
  success?: boolean;
  reason?: string;
  provider?: string;
  content?: string;
  text?: string;
  tokens?: number;
  canInterrupt?: boolean;
  tokenBudget?: unknown;
  newSessionId?: string;
  aborted?: boolean;
  [key: string]: any;
};

interface UseChatRealtimeHandlersArgs {
  latestMessage: LatestChatMessage | null;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setCurrentSessionId: (sessionId: string | null) => void;
  setIsLoading: (loading: boolean) => void;
  setCanAbortSession: (canAbort: boolean) => void;
  setClaudeStatus: (status: { text: string; tokens: number; can_interrupt: boolean } | null) => void;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  pendingViewSessionRef: MutableRefObject<PendingViewSession | null>;
  streamTimerRef: MutableRefObject<number | null>;
  accumulatedStreamRef: MutableRefObject<string>;
  thinkingStreamTimerRef: MutableRefObject<number | null>;
  accumulatedThinkingRef: MutableRefObject<string>;
  onSessionInactive?: (sessionId?: string | null) => void;
  onSessionActive?: (sessionId?: string | null) => void;
  onSessionProcessing?: (sessionId?: string | null) => void;
  onSessionNotProcessing?: (sessionId?: string | null) => void;
  onNavigateToSession?: (sessionId: string, options?: SessionNavigationOptions) => void;
  onWebSocketReconnect?: () => void;
  sessionStore: SessionStore;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatRealtimeHandlers({
  latestMessage: _latestMessage,
  provider,
  selectedSession,
  currentSessionId,
  setCurrentSessionId,
  setIsLoading,
  setCanAbortSession,
  setClaudeStatus,
  setTokenBudget,
  setPendingPermissionRequests,
  pendingViewSessionRef,
  streamTimerRef,
  accumulatedStreamRef,
  thinkingStreamTimerRef,
  accumulatedThinkingRef,
  onSessionInactive,
  onSessionActive,
  onSessionProcessing,
  onSessionNotProcessing,
  onNavigateToSession,
  onWebSocketReconnect,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const paletteOps = usePaletteOps();
  const { consumeMessages } = useWebSocket();
  const lastProcessedMessageRef = useRef<LatestChatMessage | null>(null);
  const thinkingStartTimeRef = useRef<Map<string, number>>(new Map());
  const thinkingDurationRef = useRef<Map<string, number>>(new Map());
  const thinkingEstimatedTokensRef = useRef<Map<string, number>>(new Map());
  const lastEstimatedTokensRef = useRef<Map<string, number>>(new Map());
  const lastEstimatedTokensDeltaRef = useRef<Map<string, number>>(new Map());
  const streamEndClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const completionSoundPlayedRef = useRef<Map<string, boolean>>(new Map());

  const cancelStreamEndClearTimer = () => {
    if (streamEndClearTimerRef.current) {
      clearTimeout(streamEndClearTimerRef.current);
      streamEndClearTimerRef.current = null;
    }
  };

  useEffect(() => {
    const messages = consumeMessages();
    if (messages.length === 0) return;

    messages.forEach((latestMessage) => {
      if (lastProcessedMessageRef.current === latestMessage) return;
      lastProcessedMessageRef.current = latestMessage;

      const activeViewSessionId =
        selectedSession?.id || currentSessionId || null;

      /* ---------------------------------------------------------------- */
      /*  Legacy messages (no `kind` field) — handle and return           */
      /* ---------------------------------------------------------------- */

      const msg = latestMessage as any;

    if (!msg.kind) {
      const messageType = String(msg.type || '');

      switch (messageType) {
        case 'websocket-reconnected':
          onWebSocketReconnect?.();
          return;

        case 'pending-permissions-response': {
          const permSessionId = msg.sessionId;
          const isCurrentPermSession =
            permSessionId === currentSessionId || (selectedSession && permSessionId === selectedSession.id);
          if (permSessionId && !isCurrentPermSession) return;
          setPendingPermissionRequests(msg.data || []);
          return;
        }

        case 'session-status': {
          const statusSessionId = msg.sessionId;
          if (!statusSessionId) return;

          const status = msg.status;
          if (status) {
            const statusInfo = {
              text: status.text || 'Working...',
              tokens: status.tokens || 0,
              can_interrupt: status.can_interrupt !== undefined ? status.can_interrupt : true,
            };
            setClaudeStatus(statusInfo);
            setIsLoading(true);
            setCanAbortSession(statusInfo.can_interrupt);
            return;
          }

          // Legacy isProcessing format from check-session-status
          const isCurrentSession =
            statusSessionId === currentSessionId || (selectedSession && statusSessionId === selectedSession.id);

          if (msg.isProcessing) {
            onSessionActive?.(statusSessionId);
            onSessionProcessing?.(statusSessionId);
            if (isCurrentSession) { setIsLoading(true); setCanAbortSession(true); }
            return;
          }

          onSessionInactive?.(statusSessionId);
          onSessionNotProcessing?.(statusSessionId);
          if (isCurrentSession) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
          }
          return;
        }

        default:
          // Unknown legacy message type — ignore
          return;
      }
    }

    /* ---------------------------------------------------------------- */
    /*  NormalizedMessage handling (has `kind` field)                    */
    /* ---------------------------------------------------------------- */

    const sid = msg.sessionId || activeViewSessionId;

    // --- Streaming: sync to display refresh to avoid React tearing ---
    if (msg.kind === 'stream_delta') {
      cancelStreamEndClearTimer();
      if (sid) {
        completionSoundPlayedRef.current.set(sid, false);
      }
      const text = msg.content || '';
      if (!text) return;
      accumulatedStreamRef.current += text;
      if (sid && !streamTimerRef.current) {
        streamTimerRef.current = requestAnimationFrame(() => {
          streamTimerRef.current = null;
          if (sid) {
            sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider);
          }
        });
      }
      // Also route to store for non-active sessions
      if (sid && sid !== activeViewSessionId) {
        sessionStore.appendRealtime(sid, msg as NormalizedMessage);
      }
      return;
    }

    if (msg.kind === 'stream_end') {
      if (streamTimerRef.current) {
        cancelAnimationFrame(streamTimerRef.current);
        streamTimerRef.current = null;
      }
      if (sid) {
        if (accumulatedStreamRef.current) {
          sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider);
        }
        sessionStore.finalizeStreaming(sid);
        // The SDK often takes ~1s after the last token to emit `complete`. Hide
        // the Processing banner as soon as the text stream ends, but keep a short
        // grace period so a follow-up tool_use/permission_request can keep it up.
        cancelStreamEndClearTimer();
        streamEndClearTimerRef.current = setTimeout(() => {
          streamEndClearTimerRef.current = null;
          const activeNow = selectedSession?.id || currentSessionId || null;
          if (sid === activeNow) {
            setIsLoading(false);
            setCanAbortSession(false);
            setClaudeStatus(null);
            if (!completionSoundPlayedRef.current.get(sid)) {
              showCompletionTitleIndicator();
              void playChatCompletionSound();
              completionSoundPlayedRef.current.set(sid, true);
            }
          }
          onSessionNotProcessing?.(sid);
        }, 150);
      }
      accumulatedStreamRef.current = '';
      return;
    }

    // --- Thinking streaming: sync to display refresh ---
    if (msg.kind === 'thinking_stream_delta') {
      cancelStreamEndClearTimer();
      if (sid) {
        completionSoundPlayedRef.current.set(sid, false);
      }
      const text = msg.content || '';
      if (!text) return;
      if (sid && !thinkingStartTimeRef.current.has(sid)) {
        thinkingStartTimeRef.current.set(sid, Date.now());
        clearThinkingHeaderCache(sid);
        lastEstimatedTokensRef.current.delete(sid);
        lastEstimatedTokensDeltaRef.current.delete(sid);
      }
      accumulatedThinkingRef.current += text;
      if (sid && !thinkingStreamTimerRef.current) {
        thinkingStreamTimerRef.current = requestAnimationFrame(() => {
          thinkingStreamTimerRef.current = null;
          if (sid) {
            sessionStore.updateStreamingThinking(sid, accumulatedThinkingRef.current, provider);
          }
        });
      }
      return;
    }

    if (msg.kind === 'thinking_stream_end') {
      if (thinkingStreamTimerRef.current) {
        cancelAnimationFrame(thinkingStreamTimerRef.current);
        thinkingStreamTimerRef.current = null;
      }
      if (sid) {
        if (accumulatedThinkingRef.current) {
          sessionStore.updateStreamingThinking(sid, accumulatedThinkingRef.current, provider);
        }
        const startTime = thinkingStartTimeRef.current.get(sid);
        const duration = startTime
          ? Math.ceil((Date.now() - startTime) / 1000)
          : thinkingDurationRef.current.get(sid);
        if (startTime && duration !== undefined) {
          thinkingDurationRef.current.set(sid, duration);
          thinkingStartTimeRef.current.delete(sid);
        }
        // Save this thinking block's metadata to the store so the persisted
        // thinking row (arriving later, often via server fetch) keeps duration/tokens.
        const estimatedTokens = thinkingEstimatedTokensRef.current.get(sid);
        sessionStore.setPendingThinkingMetadata(sid, {
          duration,
          estimatedTokens,
        });
        setThinkingHeaderCache(sid, {
          duration,
          tokens: estimatedTokens,
        });
        thinkingEstimatedTokensRef.current.delete(sid);
        thinkingDurationRef.current.delete(sid);
        sessionStore.finalizeStreamingThinking(sid);
      }
      accumulatedThinkingRef.current = '';
      return;
    }

    if (msg.kind === 'thinking_tokens') {
      let estimatedTokens = typeof msg.estimatedTokens === 'number' ? msg.estimatedTokens : undefined;
      if (estimatedTokens !== undefined && sid) {
        const previous = lastEstimatedTokensRef.current.get(sid);
        const delta = previous !== undefined ? estimatedTokens - previous : estimatedTokens;
        const previousDelta = lastEstimatedTokensDeltaRef.current.get(sid);
        // The SDK sometimes sends a final "correction" with a huge delta that
        // jumps from the smooth progress estimate to the actual total. Ignore
        // that spike so the displayed token count stays smooth and freezes at
        // the last progress value.
        const isSpike =
          previous !== undefined &&
          previousDelta !== undefined &&
          previousDelta > 0 &&
          delta > Math.max(50, previousDelta * 3);
        if (isSpike) {
          estimatedTokens = previous;
        } else {
          lastEstimatedTokensRef.current.set(sid, estimatedTokens);
          if (delta > 0) {
            lastEstimatedTokensDeltaRef.current.set(sid, delta);
          }
          thinkingEstimatedTokensRef.current.set(sid, estimatedTokens);
          setThinkingHeaderCache(sid, {
            ...getThinkingHeaderCache(sid),
            tokens: estimatedTokens,
          });
        }
      }
      if (sid) {
        sessionStore.updateStreamingThinking(sid, accumulatedThinkingRef.current, provider, estimatedTokens);
      }
      return;
    }

    // --- All other messages: route to store ---
    const shouldPersist =
      msg.kind !== 'session_created'
      && msg.kind !== 'complete'
      && msg.kind !== 'status'
      && msg.kind !== 'permission_request'
      && msg.kind !== 'permission_cancelled';

    if (sid && shouldPersist) {
      if (msg.kind === 'thinking') {
        const slot = sessionStore.getSessionSlot(sid);
        const pending = slot?.pendingThinkingMetadata;
        if (pending) {
          if (msg.duration === undefined && pending.duration !== undefined) {
            msg.duration = pending.duration;
          }
          if (msg.estimatedTokens === undefined && pending.estimatedTokens !== undefined) {
            msg.estimatedTokens = pending.estimatedTokens;
          }
          if (slot) {
            slot.pendingThinkingMetadata = undefined;
          }
        }
      }
      sessionStore.appendRealtime(sid, msg as NormalizedMessage);
    }

    // --- UI side effects for specific kinds ---
    switch (msg.kind) {
      case 'session_created': {
        cancelStreamEndClearTimer();
        const newSessionId = msg.newSessionId;
        if (!newSessionId) break;
        completionSoundPlayedRef.current.set(newSessionId, false);

        // We no longer synthesize client-side placeholder IDs. Until the provider
        // announces `session_created`, the active id is expected to be null.
        if (!currentSessionId) {
          setCurrentSessionId(newSessionId);
          setPendingPermissionRequests((prev) =>
            prev.map((r) => (r.sessionId ? r : { ...r, sessionId: newSessionId })),
          );
        }
        pendingViewSessionRef.current = null;
        onSessionActive?.(newSessionId);
        onSessionProcessing?.(newSessionId);
        setIsLoading(true);
        setCanAbortSession(true);
        setClaudeStatus({
          text: 'Processing',
          tokens: 0,
          can_interrupt: true,
        });
        onNavigateToSession?.(newSessionId);
        break;
      }

      case 'complete': {
        cancelStreamEndClearTimer();
        // Flush any remaining streaming state
        if (streamTimerRef.current) {
          cancelAnimationFrame(streamTimerRef.current);
          streamTimerRef.current = null;
        }
        if (sid && accumulatedStreamRef.current) {
          sessionStore.updateStreaming(sid, accumulatedStreamRef.current, provider);
          sessionStore.finalizeStreaming(sid);
        }
        accumulatedStreamRef.current = '';

        // Flush any remaining thinking streaming state
        if (thinkingStreamTimerRef.current) {
          cancelAnimationFrame(thinkingStreamTimerRef.current);
          thinkingStreamTimerRef.current = null;
        }
        if (sid && accumulatedThinkingRef.current) {
          sessionStore.updateStreamingThinking(sid, accumulatedThinkingRef.current, provider);
          sessionStore.finalizeStreamingThinking(sid);
        }
        if (sid) {
          const startTime = thinkingStartTimeRef.current.get(sid);
          if (startTime) {
            thinkingDurationRef.current.set(sid, Math.ceil((Date.now() - startTime) / 1000));
            thinkingStartTimeRef.current.delete(sid);
          }
          thinkingEstimatedTokensRef.current.delete(sid);
          lastEstimatedTokensRef.current.delete(sid);
          lastEstimatedTokensDeltaRef.current.delete(sid);
          const slot = sessionStore.getSessionSlot(sid);
          if (slot) {
            slot.pendingThinkingMetadata = undefined;
          }
        }
        accumulatedThinkingRef.current = '';

        setIsLoading(false);
        setCanAbortSession(false);
        setClaudeStatus(null);
        setPendingPermissionRequests([]);
        onSessionInactive?.(sid);
        onSessionNotProcessing?.(sid);
        pendingViewSessionRef.current = null;

        // Handle aborted case
        if (msg.aborted) {
          // Abort was requested — the complete event confirms it
          // No special UI action needed beyond clearing loading state above
          // The backend already sent any abort-related messages
          break;
        }

        if (sid && sid === activeViewSessionId && !completionSoundPlayedRef.current.get(sid)) {
          showCompletionTitleIndicator();
          void playChatCompletionSound();
          completionSoundPlayedRef.current.set(sid, true);
        }

        const actualSessionId =
          typeof msg.actualSessionId === 'string' && msg.actualSessionId.trim().length > 0
            ? msg.actualSessionId
            : null;
        const isVisibleSession =
          Boolean(
            sid
            && sid === activeViewSessionId,
          );

        if (actualSessionId && sid && actualSessionId !== sid) {
          sessionStore.replaceSessionId(sid, actualSessionId);

          if (isVisibleSession) {
            setCurrentSessionId(actualSessionId);
          }

          if (isVisibleSession) {
            onNavigateToSession?.(actualSessionId, { replace: true });
            setTimeout(() => { void paletteOps.refreshProjects(); }, 500);
          }
          break;
        }

        break;
      }

      case 'error': {
        cancelStreamEndClearTimer();
        setIsLoading(false);
        setCanAbortSession(false);
        setClaudeStatus(null);
        onSessionInactive?.(sid);
        onSessionNotProcessing?.(sid);
        pendingViewSessionRef.current = null;
        break;
      }

      case 'permission_request': {
        cancelStreamEndClearTimer();
        if (!msg.requestId) break;
        setPendingPermissionRequests((prev) => {
          if (prev.some((r: PendingPermissionRequest) => r.requestId === msg.requestId)) return prev;
          return [...prev, {
            requestId: msg.requestId,
            toolName: msg.toolName || 'UnknownTool',
            input: msg.input,
            context: msg.context,
            sessionId: sid || null,
            receivedAt: new Date(),
          }];
        });
        setIsLoading(true);
        setCanAbortSession(true);
        setClaudeStatus({ text: 'Waiting for permission', tokens: 0, can_interrupt: true });
        break;
      }

      case 'permission_cancelled': {
        if (msg.requestId) {
          setPendingPermissionRequests((prev) => prev.filter((r: PendingPermissionRequest) => r.requestId !== msg.requestId));
        }
        break;
      }

      case 'status': {
        if (msg.text === 'token_budget' && msg.tokenBudget) {
          setTokenBudget(msg.tokenBudget as Record<string, unknown>);
        } else if (msg.text) {
          cancelStreamEndClearTimer();
          setClaudeStatus({
            text: msg.text,
            tokens: msg.tokens || 0,
            can_interrupt: msg.canInterrupt !== undefined ? msg.canInterrupt : true,
          });
          setIsLoading(true);
          setCanAbortSession(msg.canInterrupt !== false);
        }
        break;
      }

      case 'tool_use': {
        cancelStreamEndClearTimer();
        if (sid && sid === activeViewSessionId) {
          onSessionProcessing?.(sid);
          setIsLoading(true);
          setCanAbortSession(true);
          setClaudeStatus({ text: 'Processing', tokens: 0, can_interrupt: true });
        }
        break;
      }

      // text, tool_use, tool_result, thinking, interactive_prompt, task_notification
      // → already routed to store above, no UI side effects needed
      default:
        break;
    }
  });
  }, [
    _latestMessage,
    consumeMessages,
    provider,
    selectedSession,
    currentSessionId,
    setCurrentSessionId,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setTokenBudget,
    setPendingPermissionRequests,
    pendingViewSessionRef,
    streamTimerRef,
    accumulatedStreamRef,
    thinkingStreamTimerRef,
    accumulatedThinkingRef,
    onSessionInactive,
    onSessionActive,
    onSessionProcessing,
    onSessionNotProcessing,
    onNavigateToSession,
    onWebSocketReconnect,
    sessionStore,
    paletteOps,
  ]);

  // Unmount-only cleanup for the stream-end grace timer. Do NOT put this in the
  // message-handling effect above: that effect re-runs on every new message and
  // would cancel the timer before it can fire.
  useEffect(() => () => {
    cancelStreamEndClearTimer();
  }, []);
}
