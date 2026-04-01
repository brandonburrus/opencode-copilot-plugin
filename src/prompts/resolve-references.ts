import * as path from "node:path"
import * as fs from "node:fs/promises"
import { pluginLog } from "../log.ts"

/** Maximum total bytes of resolved file content to include across all references in one prompt. */
const MAX_TOTAL_RESOLVED_BYTES = 100_000

/** Maximum recursion depth when resolving nested file references. */
const MAX_REFERENCE_DEPTH = 5

/**
 * Resolves markdown file references in a prompt body.
 *
 * Scans `content` for markdown links whose targets are local relative paths
 * (not URLs). For each match, reads the referenced file and replaces the link
 * with the link label followed by the file content wrapped in a
 * `<referenced_file>` XML block.
 *
 * Referenced files are resolved relative to `promptDir`. Nested references
 * inside referenced files are also resolved up to `MAX_REFERENCE_DEPTH` levels.
 *
 * Unresolvable references (missing files, permission errors, circular refs)
 * are left unchanged and a warning is written to stderr.
 *
 * Total resolved content is capped at `MAX_TOTAL_RESOLVED_BYTES` to prevent
 * context explosion. Once the cap is reached, remaining references are left
 * as their original markdown links.
 */
export async function resolveFileReferences(content: string, promptDir: string): Promise<string> {
  const state: ResolveState = { totalBytes: 0, visited: new Set() }
  return resolveContent(content, promptDir, state, 0)
}

interface ResolveState {
  totalBytes: number
  visited: Set<string>
}

async function resolveContent(
  content: string,
  baseDir: string,
  state: ResolveState,
  depth: number,
): Promise<string> {
  if (depth >= MAX_REFERENCE_DEPTH) return content

  // Match markdown links: [label](path) where path is not a URL
  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g
  const segments: string[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = linkPattern.exec(content)) !== null) {
    const fullMatch = match[0]!
    const label = match[1] ?? ""
    const href = match[2] ?? ""

    // Skip URLs and anchors — only process relative file paths
    if (isUrl(href) || href.startsWith("#")) {
      segments.push(content.slice(lastIndex, match.index + fullMatch.length))
      lastIndex = match.index + fullMatch.length
      continue
    }

    segments.push(content.slice(lastIndex, match.index))
    lastIndex = match.index + fullMatch.length

    const absolutePath = path.resolve(baseDir, href)

    // Circular reference guard
    if (state.visited.has(absolutePath)) {
      pluginLog("warn", `Skipping circular reference to ${absolutePath} in prompt`)
      segments.push(fullMatch)
      continue
    }

    // Cap guard — leave remaining references as-is once limit is hit
    if (state.totalBytes >= MAX_TOTAL_RESOLVED_BYTES) {
      segments.push(fullMatch)
      continue
    }

    let fileContent: string
    try {
      fileContent = await fs.readFile(absolutePath, "utf8")
    } catch {
      pluginLog("warn", `Warning: could not read referenced file "${absolutePath}" — leaving link as-is`)
      segments.push(fullMatch)
      continue
    }

    state.visited.add(absolutePath)
    state.totalBytes += Buffer.byteLength(fileContent, "utf8")

    // Recursively resolve references inside the referenced file
    const resolvedFileContent = await resolveContent(
      fileContent,
      path.dirname(absolutePath),
      state,
      depth + 1,
    )

    state.visited.delete(absolutePath)

    const relPath = href
    const block = buildReferencedFileBlock(label, relPath, resolvedFileContent)
    segments.push(block)
  }

  segments.push(content.slice(lastIndex))
  return segments.join("")
}

function buildReferencedFileBlock(label: string, relPath: string, content: string): string {
  const lines = [
    `<referenced_file path="${relPath}">`,
    content,
    `</referenced_file>`,
  ]
  if (label.trim()) {
    return `${label}\n${lines.join("\n")}`
  }
  return lines.join("\n")
}

function isUrl(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(href)
}
