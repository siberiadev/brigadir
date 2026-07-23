import { describe, it, expect } from 'vitest';
import { parseTemplateFile } from './frontmatter';

describe('parseTemplateFile', () => {
  it('parses frontmatter and body, slug always from the file name', () => {
    const t = parseTemplateFile(
      'developer',
      ['---', 'name: dev', 'role: Developer', 'description: Builds things.', 'model_hint: opus', 'trigger_status_hint: In Progress', '---', '', '# Role: Developer', 'Do work.'].join('\n'),
    );
    expect(t.slug).toBe('developer');
    expect(t.role).toBe('Developer');
    expect(t.description).toBe('Builds things.');
    expect(t.model_hint).toBe('opus');
    expect(t.trigger_status_hint).toBe('In Progress');
    expect(t.body).toBe('# Role: Developer\nDo work.');
  });

  it('ignores unknown frontmatter keys and comments', () => {
    const t = parseTemplateFile('qa', '---\nrole: QA\ntools: Read, Bash\n# a comment\n---\nbody');
    expect(t.role).toBe('QA');
    expect(t).not.toHaveProperty('tools');
    expect(t.body).toBe('body');
  });

  it('treats a file with no frontmatter as body-only, role falls back to slug', () => {
    const t = parseTemplateFile('reviewer', '# Reviewer\nreview the diff');
    expect(t.role).toBe('reviewer');
    expect(t.description).toBeUndefined();
    expect(t.body).toBe('# Reviewer\nreview the diff');
  });

  it('treats malformed (unterminated) frontmatter as body-only, never throws', () => {
    const t = parseTemplateFile('planner', '---\nrole: Planner\nno closing fence');
    expect(t.role).toBe('planner'); // fallback to slug (frontmatter not parsed)
    expect(t.body).toContain('no closing fence');
  });

  it('strips surrounding quotes and handles CRLF', () => {
    const t = parseTemplateFile('x', '---\r\nrole: "Boss"\r\n---\r\nhello');
    expect(t.role).toBe('Boss');
    expect(t.body).toBe('hello');
  });
});
