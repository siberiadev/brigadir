import type { ADFDoc, ADFNode } from '@brigadir/contracts';

/**
 * ADF → markdown (reverse of adf-composer.ts). Pure and dependency-free: turns
 * a Jira Cloud v3 `description` document into agent-readable markdown for the
 * run wrapper (docs/spec.md "description как markdown"). NOT a renderer — no
 * markdown-escaping of source text, the consumer is an LLM prompt, not a
 * markdown viewer. Unknown node types NEVER throw: they recurse into
 * `content` so future/exotic Jira nodes degrade to their inner text.
 */

const HEADING_MAX_LEVEL = 6;

/** Marks applied inside-out so `**` wraps `*` etc.; unknown marks pass through. */
function applyMarks(node: ADFNode): string {
  let out = node.text ?? '';
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'strong':
        out = `**${out}**`;
        break;
      case 'em':
        out = `*${out}*`;
        break;
      case 'code':
        out = `\`${out}\``;
        break;
      case 'strike':
        out = `~~${out}~~`;
        break;
      case 'link':
        out = `[${out}](${String(mark.attrs?.href ?? '')})`;
        break;
      // subsup/underline/textColor/…: markdown has no equivalent — text passes through
    }
  }
  return out;
}

/** Inline flattening: text + inline atoms (mention, emoji, …) → one string. */
function inline(nodes: ADFNode[] | undefined): string {
  return (nodes ?? []).map(inlineNode).join('');
}

function inlineNode(node: ADFNode): string {
  switch (node.type) {
    case 'text':
      return applyMarks(node);
    case 'hardBreak':
      return '\n';
    case 'mention':
      return String(node.attrs?.text ?? `@${String(node.attrs?.id ?? 'unknown')}`);
    case 'emoji':
      return String(node.attrs?.shortName ?? '');
    case 'inlineCard':
      return String(node.attrs?.url ?? '');
    case 'status':
      return String(node.attrs?.text ?? '');
    case 'date':
      return String(node.attrs?.timestamp ?? '');
    default:
      // Unknown inline node → its inner text (never throw).
      return inline(node.content);
  }
}

/** Prefix every line of `value` (blockquote bodies, nested list items). */
function indentLines(value: string, prefix: string): string {
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function listItems(nodes: ADFNode[] | undefined, marker: (i: number) => string): string {
  return (nodes ?? [])
    .map((item, i) => {
      const body = blocks(item.content);
      const head = marker(i);
      // First line gets the marker; continuation lines align under it.
      const [first, ...rest] = body.split('\n');
      const cont = rest.map((line) => (line ? `${' '.repeat(head.length)}${line}` : line));
      return [`${head}${first ?? ''}`, ...cont].join('\n');
    })
    .join('\n');
}

function tableRow(row: ADFNode): string {
  const cells = (row.content ?? []).map((cell) => blocks(cell.content).replace(/\n+/g, ' '));
  return `| ${cells.join(' | ')} |`;
}

function block(node: ADFNode): string {
  switch (node.type) {
    case 'paragraph':
      return inline(node.content);
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), HEADING_MAX_LEVEL);
      return `${'#'.repeat(level)} ${inline(node.content)}`;
    }
    case 'bulletList':
      return listItems(node.content, () => '- ');
    case 'orderedList': {
      const start = Number(node.attrs?.order ?? 1);
      return listItems(node.content, (i) => `${start + i}. `);
    }
    case 'codeBlock': {
      const language = String(node.attrs?.language ?? '');
      return `\`\`\`${language}\n${inline(node.content)}\n\`\`\``;
    }
    case 'blockquote':
      return indentLines(blocks(node.content), '> ');
    case 'panel': {
      // No markdown panel — a blockquote with the panel type as a bold lead line.
      const kind = String(node.attrs?.panelType ?? 'info');
      return indentLines(`**[${kind}]**\n${blocks(node.content)}`, '> ');
    }
    case 'rule':
      return '---';
    case 'table': {
      const rows = node.content ?? [];
      if (rows.length === 0) return '';
      const lines = rows.map(tableRow);
      const isHeader = (rows[0].content ?? []).every((c) => c.type === 'tableHeader');
      if (isHeader) {
        const cols = rows[0].content?.length ?? 0;
        lines.splice(1, 0, `|${' --- |'.repeat(cols)}`);
      }
      return lines.join('\n');
    }
    case 'taskList':
      return (node.content ?? [])
        .map((item) => `- [${item.attrs?.state === 'DONE' ? 'x' : ' '}] ${inline(item.content)}`)
        .join('\n');
    case 'mediaSingle':
    case 'mediaGroup':
      return (node.content ?? []).map(block).join('\n');
    case 'media':
      return `[attachment${node.attrs?.alt ? `: ${String(node.attrs.alt)}` : ''}]`;
    case 'expand':
    case 'nestedExpand':
      // Title as a bold line, body inline below (markdown has no <details>).
      return [node.attrs?.title ? `**${String(node.attrs.title)}**` : '', blocks(node.content)]
        .filter(Boolean)
        .join('\n');
    default:
      // Unknown block node → recurse (never throw). Leaf without content → its text.
      return node.content ? blocks(node.content) : (node.text ?? '');
  }
}

/** Block-level nodes joined by blank lines; empty blocks dropped. */
function blocks(nodes: ADFNode[] | undefined): string {
  return (nodes ?? [])
    .map(block)
    .filter((s) => s !== '')
    .join('\n\n');
}

export function adfToMarkdown(doc: ADFDoc): string {
  return blocks(doc.content).trim();
}

export const DESCRIPTION_MAX_CHARS = 10_000;
const TRUNCATION_MARKER = '\n\n…[description truncated]';

/**
 * Jira `description` field → wrapper-ready markdown. Tolerates every shape the
 * field can arrive in: absent/null → '', plain string (Jira Server / API v2)
 * → passthrough, ADF doc → adfToMarkdown. Always bounded by `maxChars` (the
 * wrapper has no budget guard of its own — same reasoning as the
 * feature-context SECTION_MAX_BYTES bound).
 */
export function jiraDescriptionToMarkdown(
  description: ADFDoc | string | null | undefined,
  maxChars = DESCRIPTION_MAX_CHARS,
): string {
  if (description == null) return '';
  const markdown = typeof description === 'string' ? description : adfToMarkdown(description);
  if (markdown.length <= maxChars) return markdown;
  return markdown.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
