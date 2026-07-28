export type MergeChoice = "local" | "remote" | "merged" | "conflict";

export interface TextMergeResult {
  readonly choice: MergeChoice;
  readonly content?: string;
}

interface Hunk {
  readonly start: number;
  readonly end: number;
  readonly replacement: readonly string[];
}

export function mergeText(
  base: string,
  local: string,
  remote: string,
): TextMergeResult {
  if (local === remote) {
    return { choice: "local", content: local };
  }
  if (local === base) {
    return { choice: "remote", content: remote };
  }
  if (remote === base) {
    return { choice: "local", content: local };
  }
  const baseLines = splitLines(base);
  const localLines = splitLines(local);
  const remoteLines = splitLines(remote);
  if (
    baseLines.length === localLines.length
    && baseLines.length === remoteLines.length
  ) {
    const merged = [...baseLines];
    for (let index = 0; index < baseLines.length; index += 1) {
      const baseLine = baseLines[index];
      const localLine = localLines[index];
      const remoteLine = remoteLines[index];
      if (localLine === remoteLine) {
        merged[index] = localLine ?? "";
      } else if (localLine === baseLine) {
        merged[index] = remoteLine ?? "";
      } else if (remoteLine === baseLine) {
        merged[index] = localLine ?? "";
      } else {
        return { choice: "conflict" };
      }
    }
    return { choice: "merged", content: merged.join("") };
  }

  const localHunk = singleHunk(baseLines, localLines);
  const remoteHunk = singleHunk(baseLines, remoteLines);
  if (hunksOverlap(localHunk, remoteHunk)) {
    if (
      localHunk.start === remoteHunk.start
      && localHunk.end === remoteHunk.end
      && arraysEqual(localHunk.replacement, remoteHunk.replacement)
    ) {
      return { choice: "merged", content: local };
    }
    return { choice: "conflict" };
  }
  const merged = [...baseLines];
  for (const hunk of [localHunk, remoteHunk].sort((a, b) => b.start - a.start)) {
    merged.splice(hunk.start, hunk.end - hunk.start, ...hunk.replacement);
  }
  return { choice: "merged", content: merged.join("") };
}

export function conflictCopyPath(
  originalPath: string,
  deviceName: string,
  timestamp: Date,
): string {
  const slash = originalPath.lastIndexOf("/");
  const directory = slash < 0 ? "" : originalPath.slice(0, slash + 1);
  const filename = slash < 0 ? originalPath : originalPath.slice(slash + 1);
  const dot = filename.lastIndexOf(".");
  const stem = dot <= 0 ? filename : filename.slice(0, dot);
  const extension = dot <= 0 ? "" : filename.slice(dot);
  const safeDevice = deviceName
    .normalize("NFC")
    .replaceAll(/[<>:"/\\|?*\p{Cc}]/gu, "_")
    .replaceAll(/[ .]+$/gu, "")
    .slice(0, 48) || "device";
  const utc = timestamp.toISOString().replaceAll(/[-:]/gu, "").replace(".000", "");
  return `${directory}${stem} (conflict-${safeDevice}-${utc})${extension}`;
}

export function conflictRecord(
  originalPath: string,
  conflictPath: string,
  reason: string,
  timestamp: Date,
): { readonly path: string; readonly content: string } {
  const date = timestamp.toISOString().slice(0, 10);
  const id = timestamp.toISOString().replaceAll(/[-:.]/gu, "");
  return {
    path: `00-Inbox/Sync Conflicts/${date}-${id}.md`,
    content: [
      "---",
      "ll_type: sync-conflict",
      `ll_created: ${timestamp.toISOString()}`,
      "---",
      "",
      "# Sync conflict",
      "",
      `- Original: [[${originalPath}]]`,
      `- Preserved copy: [[${conflictPath}]]`,
      `- Reason: ${reason}`,
      "",
    ].join("\n"),
  };
}

function splitLines(value: string): string[] {
  return value.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

function singleHunk(base: readonly string[], changed: readonly string[]): Hunk {
  let prefix = 0;
  while (
    prefix < base.length
    && prefix < changed.length
    && base[prefix] === changed[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < base.length - prefix
    && suffix < changed.length - prefix
    && base[base.length - 1 - suffix] === changed[changed.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    start: prefix,
    end: base.length - suffix,
    replacement: changed.slice(prefix, changed.length - suffix),
  };
}

function hunksOverlap(left: Hunk, right: Hunk): boolean {
  if (left.start === left.end && right.start === right.end) {
    return left.start === right.start;
  }
  return left.start < right.end && right.start < left.end;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}
