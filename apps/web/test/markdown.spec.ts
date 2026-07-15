import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/utils/markdown';

describe('renderMarkdown', () => {
  it('empty/nullish → empty string', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
  });

  it('headings, paragraphs, and inline emphasis', () => {
    expect(renderMarkdown('# Title\n\nsome **bold** and *italic* text')).toBe(
      '<h1>Title</h1>\n<p>some <strong>bold</strong> and <em>italic</em> text</p>',
    );
  });

  it('unordered and ordered lists', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. first\n2. second')).toBe('<ol><li>first</li><li>second</li></ol>');
  });

  it('inline code and fenced code blocks', () => {
    expect(renderMarkdown('use `deals_getLinkedFlags`')).toBe(
      '<p>use <code>deals_getLinkedFlags</code></p>',
    );
    expect(renderMarkdown('```ts\nconst a = 1 < 2;\n```')).toBe(
      '<pre><code>const a = 1 &lt; 2;</code></pre>',
    );
  });

  it('emphasis markers inside a code span stay literal', () => {
    expect(renderMarkdown('`a * b * c`')).toBe('<p><code>a * b * c</code></p>');
  });

  it('safe links render as anchors; unsafe schemes degrade to text', () => {
    expect(renderMarkdown('[ST3-799](https://st3.atlassian.net/browse/ST3-799)')).toBe(
      '<p><a href="https://st3.atlassian.net/browse/ST3-799" target="_blank" rel="noopener noreferrer">ST3-799</a></p>',
    );
    expect(renderMarkdown('[x](javascript:alert(1))')).toBe('<p>x (javascript:alert(1))</p>');
  });

  it('escapes HTML in the source — no author markup survives (XSS guard)', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **still bold**');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>still bold</strong>');
  });

  it('blockquote and horizontal rule', () => {
    expect(renderMarkdown('> heads up\n\n---')).toBe(
      '<blockquote>heads up</blockquote>\n<hr />',
    );
  });

  it('multi-line paragraph joins with <br />', () => {
    expect(renderMarkdown('line one\nline two')).toBe('<p>line one<br />line two</p>');
  });
});
