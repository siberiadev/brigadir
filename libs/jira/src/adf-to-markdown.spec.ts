import { describe, it, expect } from 'vitest';
import type { ADFDoc, ADFNode } from '@brigadir/contracts';
import { adfToMarkdown, jiraDescriptionToMarkdown, DESCRIPTION_MAX_CHARS } from './adf-to-markdown';

const doc = (...content: ADFNode[]): ADFDoc => ({ version: 1, type: 'doc', content });
const text = (value: string, marks?: ADFNode['marks']): ADFNode => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (...content: ADFNode[]): ADFNode => ({ type: 'paragraph', content });

describe('adfToMarkdown', () => {
  it('empty doc → empty string', () => {
    expect(adfToMarkdown(doc())).toBe('');
  });

  it('paragraphs joined by blank lines', () => {
    expect(adfToMarkdown(doc(paragraph(text('one')), paragraph(text('two'))))).toBe('one\n\ntwo');
  });

  it('headings honor attrs.level and clamp to 1..6', () => {
    expect(
      adfToMarkdown(
        doc(
          { type: 'heading', attrs: { level: 2 }, content: [text('Title')] },
          { type: 'heading', attrs: { level: 99 }, content: [text('Deep')] },
          { type: 'heading', content: [text('Default')] },
        ),
      ),
    ).toBe('## Title\n\n###### Deep\n\n# Default');
  });

  it('bullet list, and ordered list honoring attrs.order', () => {
    expect(
      adfToMarkdown(
        doc(
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [paragraph(text('a'))] },
              { type: 'listItem', content: [paragraph(text('b'))] },
            ],
          },
          {
            type: 'orderedList',
            attrs: { order: 3 },
            content: [
              { type: 'listItem', content: [paragraph(text('third'))] },
              { type: 'listItem', content: [paragraph(text('fourth'))] },
            ],
          },
        ),
      ),
    ).toBe('- a\n- b\n\n3. third\n4. fourth');
  });

  it('nested bullet list inside an ordered item aligns under the marker', () => {
    expect(
      adfToMarkdown(
        doc({
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [
                paragraph(text('outer')),
                {
                  type: 'bulletList',
                  content: [{ type: 'listItem', content: [paragraph(text('inner'))] }],
                },
              ],
            },
          ],
        }),
      ),
    ).toBe('1. outer\n\n   - inner');
  });

  it('codeBlock fences with and without a language', () => {
    expect(
      adfToMarkdown(
        doc(
          { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('const a = 1;')] },
          { type: 'codeBlock', content: [text('plain')] },
        ),
      ),
    ).toBe('```ts\nconst a = 1;\n```\n\n```\nplain\n```');
  });

  it('blockquote prefixes every line; panel adds a bold type lead', () => {
    expect(
      adfToMarkdown(
        doc(
          { type: 'blockquote', content: [paragraph(text('quoted')), paragraph(text('more'))] },
          { type: 'panel', attrs: { panelType: 'warning' }, content: [paragraph(text('careful'))] },
        ),
      ),
    ).toBe('> quoted\n> \n> more\n\n> **[warning]**\n> careful');
  });

  it('rule and hardBreak', () => {
    expect(adfToMarkdown(doc(paragraph(text('a'), { type: 'hardBreak' }, text('b')), { type: 'rule' })))
      .toBe('a\nb\n\n---');
  });

  it('table with a header row gets a separator', () => {
    const cell = (type: 'tableHeader' | 'tableCell', value: string): ADFNode => ({
      type,
      content: [paragraph(text(value))],
    });
    expect(
      adfToMarkdown(
        doc({
          type: 'table',
          content: [
            { type: 'tableRow', content: [cell('tableHeader', 'K'), cell('tableHeader', 'V')] },
            { type: 'tableRow', content: [cell('tableCell', 'a'), cell('tableCell', '1')] },
          ],
        }),
      ),
    ).toBe('| K | V |\n| --- | --- |\n| a | 1 |');
  });

  it('taskList renders checkbox state', () => {
    expect(
      adfToMarkdown(
        doc({
          type: 'taskList',
          content: [
            { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('done thing')] },
            { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('open thing')] },
          ],
        }),
      ),
    ).toBe('- [x] done thing\n- [ ] open thing');
  });

  it('media becomes a placeholder; mediaSingle unwraps', () => {
    expect(
      adfToMarkdown(
        doc({
          type: 'mediaSingle',
          content: [{ type: 'media', attrs: { alt: 'diagram.png' } }, { type: 'media' }],
        }),
      ),
    ).toBe('[attachment: diagram.png]\n[attachment]');
  });

  it('all marks, and combined strong+em+link', () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(
            text('bold', [{ type: 'strong' }]),
            text(' '),
            text('it', [{ type: 'em' }]),
            text(' '),
            text('mono', [{ type: 'code' }]),
            text(' '),
            text('gone', [{ type: 'strike' }]),
            text(' '),
            text('site', [{ type: 'link', attrs: { href: 'https://x.io' } }]),
            text(' '),
            text('both', [{ type: 'strong' }, { type: 'em' }, { type: 'link', attrs: { href: 'https://y.io' } }]),
          ),
        ),
      ),
    ).toBe('**bold** *it* `mono` ~~gone~~ [site](https://x.io) [***both***](https://y.io)');
  });

  it('unknown marks pass the text through', () => {
    expect(adfToMarkdown(doc(paragraph(text('colored', [{ type: 'textColor', attrs: { color: '#ff0000' } }])))))
      .toBe('colored');
  });

  it('inline atoms: mention/emoji/inlineCard/status/date, with missing attrs fallbacks', () => {
    expect(
      adfToMarkdown(
        doc(
          paragraph(
            { type: 'mention', attrs: { text: '@dg' } },
            text(' '),
            { type: 'mention', attrs: { id: '712020' } },
            text(' '),
            { type: 'mention' },
            text(' '),
            { type: 'emoji', attrs: { shortName: ':fire:' } },
            text(' '),
            { type: 'emoji' },
            { type: 'inlineCard', attrs: { url: 'https://st3.atlassian.net/browse/ST3-799' } },
            text(' '),
            { type: 'status', attrs: { text: 'READY' } },
            text(' '),
            { type: 'date', attrs: { timestamp: '1750000000000' } },
          ),
        ),
      ),
    ).toBe('@dg @712020 @unknown :fire: https://st3.atlassian.net/browse/ST3-799 READY 1750000000000');
  });

  it('expand renders its title bold above the body', () => {
    expect(
      adfToMarkdown(
        doc({ type: 'expand', attrs: { title: 'Details' }, content: [paragraph(text('hidden'))] }),
      ),
    ).toBe('**Details**\nhidden');
  });

  it('unknown block node recurses into content instead of throwing', () => {
    expect(
      adfToMarkdown(
        doc({ type: 'futureWidget', content: [paragraph(text('inner survives'))] }),
      ),
    ).toBe('inner survives');
  });

  it('text node with missing text and content-less unknown leaf are safe', () => {
    expect(adfToMarkdown(doc(paragraph({ type: 'text' }), { type: 'mysteryLeaf' }))).toBe('');
  });

  it('composite document snapshot', () => {
    expect(
      adfToMarkdown(
        doc(
          { type: 'heading', attrs: { level: 2 }, content: [text('Expected Behavior')] },
          paragraph(text('Output must be '), text('{ linkedFlags, totalFlags }', [{ type: 'code' }]), text('.')),
          {
            type: 'bulletList',
            content: [
              { type: 'listItem', content: [paragraph(text('no '), text('processingTime', [{ type: 'code' }]))] },
              {
                type: 'listItem',
                content: [
                  paragraph(text('confirmation-gated', [{ type: 'strong' }])),
                  {
                    type: 'bulletList',
                    content: [{ type: 'listItem', content: [paragraph(text('reject when absent'))] }],
                  },
                ],
              },
            ],
          },
          { type: 'codeBlock', attrs: { language: 'json' }, content: [text('{ "linkedFlags": [] }')] },
          { type: 'panel', attrs: { panelType: 'note' }, content: [paragraph(text('Phase 2 is a follow-up.'))] },
        ),
      ),
    ).toMatchSnapshot();
  });
});

describe('jiraDescriptionToMarkdown', () => {
  it('null/undefined → empty string', () => {
    expect(jiraDescriptionToMarkdown(null)).toBe('');
    expect(jiraDescriptionToMarkdown(undefined)).toBe('');
  });

  it('plain string (Jira Server / v2) passes through', () => {
    expect(jiraDescriptionToMarkdown('already text')).toBe('already text');
  });

  it('ADF doc is converted', () => {
    expect(jiraDescriptionToMarkdown(doc(paragraph(text('hi'))))).toBe('hi');
  });

  it('over-limit output is truncated with the marker, within maxChars', () => {
    const out = jiraDescriptionToMarkdown('x'.repeat(DESCRIPTION_MAX_CHARS + 1), 100);
    expect(out.length).toBe(100);
    expect(out.endsWith('…[description truncated]')).toBe(true);
  });

  it('output at exactly maxChars is not truncated', () => {
    const exact = 'y'.repeat(100);
    expect(jiraDescriptionToMarkdown(exact, 100)).toBe(exact);
  });
});
