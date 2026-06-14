import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import PermissionContext from '../../../contexts/PermissionContext';
import { api } from '../../../utils/api';
import { QuickSettingsPanel } from '../../quick-settings-panel';
import type { ChatInterfaceProps, Provider  } from '../types/types';
import type { LLMProvider } from '../../../types/app';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { safeLocalStorage } from '../utils/chatStorage';
import { useSessionStore } from '../../../stores/useSessionStore';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import CommandResultModal from './subcomponents/CommandResultModal';


type PendingViewSession = {
  startedAt: number;
};

function ChatInterface({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  latestMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionActive,
  onSessionInactive,
  onSessionProcessing,
  onSessionNotProcessing,
  processingSessions,
  onNavigateToSession,
  onShowSettings,
  autoExpandTools,
  showRawParameters,
  showThinking,
  autoScrollToBottom,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { t } = useTranslation('chat');

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const thinkingStreamTimerRef = useRef<number | null>(null);
  const accumulatedThinkingRef = useRef('');
  const pendingViewSessionRef = useRef<PendingViewSession | null>(null);

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      cancelAnimationFrame(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
    if (thinkingStreamTimerRef.current) {
      cancelAnimationFrame(thinkingStreamTimerRef.current);
      thinkingStreamTimerRef.current = null;
    }
    accumulatedThinkingRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    geminiModel,
    setGeminiModel,
    opencodeModel,
    setOpenCodeModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    hardRefreshProviderModels,
    selectProviderModel,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    isLoading,
    setIsLoading,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    canAbortSession,
    setCanAbortSession,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    claudeStatus,
    setClaudeStatus,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    autoScrollToBottom,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    resetStreamingState,
    pendingViewSessionRef,
    sessionStore,
  });

  const [branchInfo, setBranchInfo] = useState<{ branchId: string; name: string | null; parentName: string | null } | null>(null);

  useEffect(() => {
    if (!currentSessionId) {
      setBranchInfo(null);
      return;
    }
    let cancelled = false;
    setBranchInfo(null);
    api.get(`/providers/sessions/${encodeURIComponent(currentSessionId)}/branch-info`)
      .then(async (res) => {
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled && json?.data?.branch) {
          setBranchInfo(json.data.branch);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [currentSessionId]);

  const {
    input,
    setInput,
    inputValueRef,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedImages,
    setAttachedImages,
    uploadingImages,
    imageErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openImagePicker,
    handleSubmit,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused: _isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    cursorModel,
    claudeModel,
    codexModel,
    geminiModel,
    opencodeModel,
    isLoading,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionActive,
    onSessionProcessing,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    onNavigateToSession,
    pendingViewSessionRef,
    scrollToBottom,
    addMessage,
    setIsLoading,
    setCanAbortSession,
    setClaudeStatus,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
  });

  const handleBranchFromMessage = useCallback(async (messageId: string) => {
    if (!currentSessionId) return;
    const targetMessage = chatMessages.find(
      (m) => m.id && m.id.split('_text')[0] === messageId,
    );
    const messageText = targetMessage?.content || '';
    try {
      const res = await api.post(`/providers/sessions/${encodeURIComponent(currentSessionId)}/branches`, { messageId });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const serverMessage = errorData?.error?.message || errorData?.message;
        throw new Error(serverMessage || `Failed to create branch (${res.status})`);
      }
      const json = await res.json();
      const branchId = json?.data?.branchId;
      if (branchId) {
        safeLocalStorage.setItem(`draft_input_${selectedProject?.projectId}`, messageText);
        setInput(messageText);
        inputValueRef.current = messageText;
        setAttachedImages([]);
        onNavigateToSession?.(branchId);
        setTimeout(() => {
          textareaRef.current?.focus();
        }, 50);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('Branch failed:', err);
      addMessage({
        type: 'error',
        content: `Failed to create branch: ${message}`,
        timestamp: Date.now(),
      });
    }
  }, [currentSessionId, chatMessages, setInput, inputValueRef, setAttachedImages, onNavigateToSession, addMessage, textareaRef, selectedProject]);

  const handleRewindToMessage = useCallback(async (messageId: string) => {
    if (!currentSessionId) return;
    const targetMessage = chatMessages.find(
      (m) => m.id && m.id.split('_text')[0] === messageId,
    );
    const messageText = targetMessage?.content || '';
    try {
      const res = await api.post(`/providers/sessions/${encodeURIComponent(currentSessionId)}/rewind`, { messageId });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const serverMessage = errorData?.error?.message || errorData?.message;
        throw new Error(serverMessage || `Failed to rewind (${res.status})`);
      }
      const json = await res.json();
      const branchId = json?.data?.branchId;
      if (branchId) {
        safeLocalStorage.setItem(`draft_input_${selectedProject?.projectId}`, messageText);
        setInput(messageText);
        inputValueRef.current = messageText;
        setAttachedImages([]);
        onNavigateToSession?.(branchId);
        setTimeout(() => {
          textareaRef.current?.focus();
        }, 50);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('Rewind failed:', err);
      addMessage({
        type: 'error',
        content: `Failed to rewind: ${message}`,
        timestamp: Date.now(),
      });
    }
  }, [currentSessionId, chatMessages, setInput, inputValueRef, setAttachedImages, onNavigateToSession, addMessage, textareaRef, selectedProject]);

  // On WebSocket reconnect, re-fetch the current session's messages from the server
  // so missed streaming events are shown. Also reset isLoading.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    const providerVal = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    await sessionStore.refreshFromServer(selectedSession.id, {
      provider: (selectedSession.__provider || providerVal) as LLMProvider,
      // Use DB projectId; legacy folder-derived projectName is no longer accepted here.
      projectId: selectedProject.projectId,
      projectPath: selectedProject.fullPath || selectedProject.path || '',
    });
    setIsLoading(false);
    setCanAbortSession(false);
  }, [selectedProject, selectedSession, sessionStore, setIsLoading, setCanAbortSession]);

  useChatRealtimeHandlers({
    latestMessage,
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
    onWebSocketReconnect: handleWebSocketReconnect,
    sessionStore,
  });

  useEffect(() => {
    if (!isLoading || !canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, isLoading]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  if (!selectedProject) {
    const selectedProviderLabel =
      provider === 'cursor'
        ? t('messageTypes.cursor')
        : provider === 'codex'
          ? t('messageTypes.codex')
          : provider === 'gemini'
            ? t('messageTypes.gemini')
            : provider === 'opencode'
              ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
            : t('messageTypes.claude');

    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full flex-col">
        {branchInfo && (
          <div className="flex items-center gap-2 border-b border-border/70 bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">Branch</span>
            <span className="truncate">{branchInfo.name || branchInfo.branchId}</span>
            {branchInfo.parentName && (
              <span className="truncate">from {branchInfo.parentName}</span>
            )}
          </div>
        )}

        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          geminiModel={geminiModel}
          setGeminiModel={setGeminiModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          providerModelCatalog={providerModelCatalog}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onBranchFromMessage={handleBranchFromMessage}
          onRewindToMessage={handleRewindToMessage}
          onGrantToolPermission={handleGrantToolPermission}
          autoExpandTools={autoExpandTools}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
        />

        <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          claudeStatus={claudeStatus}
          isLoading={isLoading}
          onAbortSession={handleAbortSession}
          provider={provider}
          permissionMode={permissionMode}
          onModeSwitch={cyclePermissionMode}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          isUserScrolledUp={isUserScrolledUp}
          hasMessages={chatMessages.length > 0}
          onScrollToBottom={scrollToBottomAndReset}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          attachedImages={attachedImages}
          onRemoveImage={(index) =>
            setAttachedImages((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingImages={uploadingImages}
          imageErrors={imageErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openImagePicker={openImagePicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', {
            provider:
              provider === 'cursor'
                ? t('messageTypes.cursor')
                : provider === 'codex'
                  ? t('messageTypes.codex')
                  : provider === 'gemini'
                    ? t('messageTypes.gemini')
                    : provider === 'opencode'
                      ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
                    : t('messageTypes.claude'),
          })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
      </div>

      <QuickSettingsPanel />

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        onHardRefreshProviderModels={hardRefreshProviderModels}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
        onNavigateToSession={onNavigateToSession}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
