import type { HookAPI } from "@mariozechner/pi-coding-agent/hooks";

const DEFAULT_MAX_BLOCKS = 40;   // how many "dir headers" (blocks) under a top-level dir
const DEFAULT_MAX_ENTRIES = 1200; // how many total entries under a top-level dir

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function isRecursiveLs(cmdRaw: unknown): cmdRaw is string {
  if (typeof cmdRaw !== "string") return false;
  const cmd = cmdRaw.trim();
  const startsWithLs = /^(\w+=\S+\s+)*ls(\s+|$)/.test(cmd);
  if (!startsWithLs) return false;
  return /(^|\s)-[^\n]*R([^\n]*\s|$)/.test(cmd) || /(^|\s)--recursive(\s|$)/.test(cmd);
}

function extractStdout(event: any): string | null {
  if (typeof event?.fullResult === "string") return event.fullResult;
  if (typeof event?.result === "string") return event.result;

  if (event?.fullResult && typeof event.fullResult?.stdout === "string") return event.fullResult.stdout;
  if (event?.result && typeof event.result?.stdout === "string") return event.result.stdout;

  const blocks = event?.result?.content ?? event?.fullResult?.content;
  if (Array.isArray(blocks)) {
    const texts = blocks
      .map((b: any) => (b?.type === "text" ? String(b.text ?? "") : ""))
      .filter((s: string) => s.length > 0);
    if (texts.length) return texts.join("\n");
  }

  return null;
}

type Block = { path: string; header: string; entries: string[] };

function normalizeHeaderPath(line: string): string {
  // ".:" -> "."
  // "./src:" -> "./src"
  const p = line.slice(0, -1).trim();
  if (p === "." || p === "./") return ".";
  return p;
}

function topDirOf(path: string): string | null {
  if (path === ".") return null;
  const p = path.startsWith("./") ? path.slice(2) : path;
  const seg = p.split("/").filter(Boolean)[0];
  return seg ?? null;
}

function parseLsR(stdout: string): Block[] {
  const lines = stdout.split("\n").map((l) => l.replace(/\r$/, ""));
  const blocks: Block[] = [];

  let current: Block | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    if (line.endsWith(":")) {
      const path = normalizeHeaderPath(line);
      current = { path, header: line, entries: [] };
      blocks.push(current);
      continue;
    }

    if (!current) {
      // fallback: if no header seen yet, assume root
      current = { path: ".", header: ".:", entries: [] };
      blocks.push(current);
    }
    current.entries.push(line.trim());
  }

  return blocks;
}

export default function (pi: HookAPI) {
  const maxBlocks = envInt("LS_HOOK_TOPDIR_MAX_BLOCKS", DEFAULT_MAX_BLOCKS);
  const maxEntries = envInt("LS_HOOK_TOPDIR_MAX_ENTRIES", DEFAULT_MAX_ENTRIES);

  pi.on("tool_result", async (event: any) => {

    const command =
      event?.request?.parameters?.command ??
      event?.input?.command ??
      event?.parameters?.command ??
      "";

    if (event?.toolName !== "bash") return undefined;
    if (!isRecursiveLs(command)) return undefined;

    const stdout = extractStdout(event);
    if (!stdout) return undefined;

    const blocks = parseLsR(stdout);

    // Stats per top-level dir (target, node_modules, ...)
    const stats = new Map<string, { blocks: number; entries: number }>();
    for (const b of blocks) {
      const td = topDirOf(b.path);
      if (!td) continue;
      const s = stats.get(td) ?? { blocks: 0, entries: 0 };
      s.blocks += 1;
      s.entries += b.entries.length;
      stats.set(td, s);
    }

    // Decide what to suppress
    const suppressed = new Map<string, { blocks: number; entries: number }>();
    for (const [td, s] of stats.entries()) {
      if (s.blocks > maxBlocks || s.entries > maxEntries) {
        suppressed.set(td, s);
      }
    }

    // If nothing is too big, do nothing
    if (suppressed.size === 0) return undefined;

    // Rebuild output:
    // - keep root block, but annotate suppressed dirs in root listing
    // - drop all blocks belonging to suppressed top-level dirs
    const out: string[] = [];

    const root = blocks.find((b) => b.path === ".");
    if (root) {
      out.push(root.header);

      for (const entry of root.entries) {
        const td = entry.replace(/\/$/, ""); // sometimes directories show as "name/"
        const s = suppressed.get(td);
        if (s) {
          out.push(`${entry}  # suppressed (${s.blocks} dirs, ${s.entries} entries)`);
        } else {
          out.push(entry);
        }
      }
      out.push("");
    }

    for (const b of blocks) {
      if (b.path === ".") continue;

      const td = topDirOf(b.path);
      if (td && suppressed.has(td)) continue; // drop suppressed top-level dir subtree

      out.push(b.header);
      out.push(...b.entries);
      out.push("");
    }

    const finalText = out.join("\n").trimEnd();

    // Return in a simple form that most hook runners understand
    return { result: finalText };
  });
}
