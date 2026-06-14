import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type BranchTranscriptResult = {
  branchPointTimestamp: string;
  messageCount: number;
};

/**
 * Copies a Claude JSONL transcript up to a specific message and rewrites all
 * sessionId fields to the new branch id. Also mirrors the parent session's
 * subagents/tool-results directory if one exists.
 */
export async function copyTranscriptToBranch(
  parentJsonlPath: string,
  targetJsonlPath: string,
  branchPointMessageId: string,
  newSessionId: string,
  options: { includeBranchPoint?: boolean } = {},
): Promise<BranchTranscriptResult> {
  const parentDir = path.dirname(parentJsonlPath);
  const parentSessionId = path.basename(parentJsonlPath, '.jsonl');
  const parentSessionDir = path.join(parentDir, parentSessionId);
  const branchSessionDir = path.join(parentDir, newSessionId);
  const includeBranchPoint = options.includeBranchPoint !== false;

  const content = await fsp.readFile(parentJsonlPath, 'utf8');
  const lines = content.split(/\r?\n/);
  const outputLines: string[] = [];
  let branchPointTimestamp = new Date().toISOString();
  let found = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof entry.sessionId === 'string') {
      entry.sessionId = newSessionId;
    }

    if (entry.uuid === branchPointMessageId) {
      found = true;
      if (typeof entry.timestamp === 'string') {
        branchPointTimestamp = entry.timestamp;
      }
      if (includeBranchPoint) {
        outputLines.push(JSON.stringify(entry));
      }
      break;
    }

    outputLines.push(JSON.stringify(entry));
  }

  if (!found) {
    throw new Error(`Branch point message ${branchPointMessageId} not found in ${parentJsonlPath}`);
  }

  await fsp.mkdir(path.dirname(targetJsonlPath), { recursive: true });
  await fsp.writeFile(targetJsonlPath, outputLines.join('\n') + '\n');

  // Mirror any subagents/tool-results directory the parent session owns.
  if (fs.existsSync(parentSessionDir)) {
    await copySessionDirectory(parentSessionDir, branchSessionDir, newSessionId);
  }

  return { branchPointTimestamp, messageCount: outputLines.length };
}

async function copySessionDirectory(
  sourceDir: string,
  targetDir: string,
  newSessionId: string,
): Promise<void> {
  await fsp.mkdir(targetDir, { recursive: true });
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copySessionDirectory(sourcePath, targetPath, newSessionId);
      continue;
    }

    if (!entry.isFile()) continue;

    if (entry.name.endsWith('.jsonl')) {
      const content = await fsp.readFile(sourcePath, 'utf8');
      const lines = content.split(/\r?\n/);
      const rewritten = lines
        .map((line) => {
          if (!line.trim()) return line;
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            if (typeof obj.sessionId === 'string') {
              obj.sessionId = newSessionId;
            }
            return JSON.stringify(obj);
          } catch {
            return line;
          }
        })
        .join('\n');
      await fsp.writeFile(targetPath, rewritten);
    } else {
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
}
