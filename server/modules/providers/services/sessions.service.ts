import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { copyTranscriptToBranch } from '@/modules/providers/utils/branch-transcript.utils.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type ArchivedSessionListItem = {
  sessionId: string;
  provider: LLMProvider;
  projectId: string | null;
  projectPath: string | null;
  projectDisplayName: string;
  sessionTitle: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivity: string | null;
  isProjectArchived: boolean;
};

/**
 * Removes one file if it exists.
 */
async function removeFileIfExists(filePath: string): Promise<boolean> {
  try {
    await fsp.unlink(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Archive rows need a stable project label even when the owning project is not
 * part of the active sidebar payload. This lightweight resolver keeps the
 * archive API self-contained while still matching the project's stored display
 * name when one exists.
 */
function resolveProjectDisplayName(
  projectPath: string | null,
  customProjectName: string | null | undefined,
): string {
  const trimmedCustomName = typeof customProjectName === 'string' ? customProjectName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  if (!projectPath) {
    return 'Unknown Project';
  }

  return path.basename(projectPath) || projectPath;
}

/**
 * Application service for provider-backed session message operations.
 *
 * Callers pass a provider id and this service resolves the concrete provider
 * class, keeping normalization/history call sites decoupled from implementation
 * file layout.
 */
export const sessionsService = {
  /**
   * Lists provider ids that can load session history and normalize live messages.
   */
  listProviderIds(): LLMProvider[] {
    return providerRegistry.listProviders().map((provider) => provider.id);
  },

  /**
   * Normalizes one provider-native event into frontend session message events.
   */
  normalizeMessage(
    providerName: string,
    raw: unknown,
    sessionId: string | null,
  ): NormalizedMessage[] {
    return providerRegistry.resolveProvider(providerName).sessions.normalizeMessage(raw, sessionId);
  },

  /**
   * Fetches persisted history by session id.
   *
   * Provider and provider-specific lookup hints are resolved from the indexed
   * session metadata in the database.
   */
  async fetchHistory(
    sessionId: string,
    options: Pick<FetchHistoryOptions, 'limit' | 'offset'> = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const provider = session.provider as LLMProvider;
    const history = await providerRegistry.resolveProvider(provider).sessions.fetchHistory(sessionId, {
      limit: options.limit ?? null,
      offset: options.offset ?? 0,
      projectPath: session.project_path ?? '',
    });

    return {
      ...history,
      parentSessionId: session.parent_session_id ?? null,
    };
  },

  /**
   * Returns archived sessions with enough project metadata for the sidebar to
   * group, filter, open, and restore them without a per-row follow-up query.
   */
  listArchivedSessions(): ArchivedSessionListItem[] {
    const archivedSessions = sessionsDb.getArchivedSessions();
    const projectCache = new Map<string, ReturnType<typeof projectsDb.getProjectPath>>();

    return archivedSessions.map((session) => {
      const projectPath = session.project_path?.trim() ? session.project_path : null;
      let project = null;

      if (projectPath) {
        if (!projectCache.has(projectPath)) {
          projectCache.set(projectPath, projectsDb.getProjectPath(projectPath));
        }
        project = projectCache.get(projectPath) ?? null;
      }

      return {
        sessionId: session.session_id,
        provider: session.provider as LLMProvider,
        projectId: project?.project_id ?? null,
        projectPath,
        projectDisplayName: resolveProjectDisplayName(projectPath, project?.custom_project_name),
        sessionTitle: session.custom_name?.trim() || session.session_id,
        createdAt: session.created_at ?? null,
        updatedAt: session.updated_at ?? null,
        lastActivity: session.updated_at ?? session.created_at ?? null,
        isProjectArchived: Boolean(project?.isArchived),
      };
    });
  },

  /**
   * Archives or permanently deletes one persisted session row by id.
   *
   * Soft-delete mirrors the project behavior by toggling `isArchived` so the
   * row disappears from active lists but remains restorable. Force-delete
   * optionally removes the transcript file before deleting the database row.
   */
  async deleteOrArchiveSessionById(
    sessionId: string,
    options: {
      force?: boolean;
      deletedFromDisk?: boolean;
    } = {},
  ): Promise<{ sessionId: string; action: 'archived' | 'deleted'; deletedFromDisk: boolean }> {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!options.force) {
      sessionsDb.updateSessionIsArchived(sessionId, true);
      return {
        sessionId,
        action: 'archived',
        deletedFromDisk: false,
      };
    }

    let removedFromDisk = false;
    if (options.deletedFromDisk && session.jsonl_path) {
      removedFromDisk = await removeFileIfExists(session.jsonl_path);
    }

    const deleted = sessionsDb.deleteSessionById(sessionId);
    if (!deleted) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      sessionId,
      action: 'deleted',
      deletedFromDisk: removedFromDisk,
    };
  },

  /**
   * Restores one archived session back into the active sidebar lists.
   */
  restoreSessionById(sessionId: string): { sessionId: string; isArchived: false } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionIsArchived(sessionId, false);
    return { sessionId, isArchived: false };
  },

  /**
   * Renames one session by id without requiring the caller to pass provider.
   */
  renameSessionById(sessionId: string, summary: string): { sessionId: string; summary: string } {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      throw new AppError(`Session "${sessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    sessionsDb.updateSessionCustomName(sessionId, summary);
    return { sessionId, summary };
  },

  /**
   * Creates a new branch session from an existing message in the parent session.
   * The parent transcript is copied up to (and including) the branch point message,
   * and all sessionId fields are rewritten to the new branch id.
   */
  async createBranch(
    parentSessionId: string,
    branchPointMessageId: string,
    name?: string,
    includeBranchPoint = false,
  ): Promise<{
    branchId: string;
    parentSessionId: string;
    branchPointMessageId: string;
    name: string;
  }> {
    const parent = sessionsDb.getSessionById(parentSessionId);
    if (!parent) {
      throw new AppError(`Session "${parentSessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!parent.jsonl_path) {
      throw new AppError(`Session "${parentSessionId}" has no transcript file.`, {
        code: 'SESSION_NO_TRANSCRIPT',
        statusCode: 400,
      });
    }

    if (parent.provider !== 'claude') {
      throw new AppError(`Branching is only supported for Claude sessions right now.`, {
        code: 'BRANCH_PROVIDER_NOT_SUPPORTED',
        statusCode: 400,
      });
    }

    // Verify the branch point message actually exists in the transcript.
    const transcriptContent = await fsp.readFile(parent.jsonl_path, 'utf8');
    const hasBranchPoint = transcriptContent.split(/\r?\n/).some((line) => {
      if (!line.trim()) return false;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        return entry.uuid === branchPointMessageId;
      } catch {
        return false;
      }
    });
    if (!hasBranchPoint) {
      throw new AppError(
        `Message "${branchPointMessageId}" was not found in the transcript. Only persisted messages can be branched.`,
        {
          code: 'BRANCH_POINT_NOT_FOUND',
          statusCode: 400,
        },
      );
    }

    const branchId = randomUUID();
    const projectDir = path.dirname(parent.jsonl_path);
    const newJsonlPath = path.join(projectDir, `${branchId}.jsonl`);
    const branchInfo = await copyTranscriptToBranch(
      parent.jsonl_path,
      newJsonlPath,
      branchPointMessageId,
      branchId,
      { includeBranchPoint },
    );

    const branchName = (name?.trim() || `Branch of ${parentSessionId.slice(0, 8)}`).slice(0, 200);
    const now = new Date().toISOString();

    sessionsDb.createSession(
      branchId,
      parent.provider,
      parent.project_path ?? '',
      branchName,
      now,
      now,
      newJsonlPath,
      parentSessionId,
    );
    sessionsDb.createBranch(
      branchId,
      parentSessionId,
      branchPointMessageId,
      branchInfo.branchPointTimestamp,
      branchName,
    );

    return {
      branchId,
      parentSessionId,
      branchPointMessageId,
      name: branchName,
    };
  },

  /**
   * Rewinds a session by branching at a message and archiving the parent.
   */
  async rewindSession(
    parentSessionId: string,
    branchPointMessageId: string,
  ): Promise<{
    branchId: string;
    parentSessionId: string;
    branchPointMessageId: string;
    name: string;
  }> {
    const branch = await this.createBranch(
      parentSessionId,
      branchPointMessageId,
      `Rewound from ${parentSessionId.slice(0, 8)}`,
      false,
    );
    sessionsDb.updateSessionIsArchived(parentSessionId, true);
    return branch;
  },

  /**
   * Lists all branches forked from a session.
   */
  listBranches(parentSessionId: string): Array<{
    branchId: string;
    parentSessionId: string;
    branchPointMessageId: string;
    branchPointTimestamp: string | null;
    name: string | null;
    createdAt: string;
  }> {
    const parent = sessionsDb.getSessionById(parentSessionId);
    if (!parent) {
      throw new AppError(`Session "${parentSessionId}" was not found.`, {
        code: 'SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }
    return sessionsDb.getBranchesByParentSessionId(parentSessionId);
  },

  /**
   * Renames a branch.
   */
  renameBranch(branchId: string, name: string): { branchId: string; name: string } {
    const branch = sessionsDb.getBranchById(branchId);
    if (!branch) {
      throw new AppError(`Branch "${branchId}" was not found.`, {
        code: 'BRANCH_NOT_FOUND',
        statusCode: 404,
      });
    }
    const trimmedName = name.trim().slice(0, 200);
    sessionsDb.updateBranchName(branchId, trimmedName);
    sessionsDb.updateSessionCustomName(branchId, trimmedName);
    return { branchId, name: trimmedName };
  },

  /**
   * Deletes a branch record and its transcript files.
   */
  async deleteBranch(branchId: string): Promise<{ deleted: boolean }> {
    const branch = sessionsDb.getBranchById(branchId);
    if (!branch) {
      throw new AppError(`Branch "${branchId}" was not found.`, {
        code: 'BRANCH_NOT_FOUND',
        statusCode: 404,
      });
    }

    const session = sessionsDb.getSessionById(branchId);
    if (session?.jsonl_path) {
      await removeFileIfExists(session.jsonl_path);
      const sessionDir = path.join(path.dirname(session.jsonl_path), branchId);
      try {
        await fsp.rm(sessionDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }

    sessionsDb.deleteBranchById(branchId);
    sessionsDb.deleteSessionById(branchId);
    return { deleted: true };
  },

  /**
   * Returns branch metadata for a session if it is a branch.
   */
  getBranchInfo(branchId: string): {
    branchId: string;
    parentSessionId: string;
    branchPointMessageId: string;
    branchPointTimestamp: string | null;
    name: string | null;
    createdAt: string;
    parentName: string | null;
  } | null {
    const branch = sessionsDb.getBranchById(branchId);
    if (!branch) return null;
    const parent = sessionsDb.getSessionById(branch.parentSessionId);
    return {
      ...branch,
      parentName: parent?.custom_name ?? null,
    };
  },
};
