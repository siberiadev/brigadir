import { describe, it, expect } from 'vitest';
import type { BrigadirDb } from '@brigadir/database';
import type { AgentReport, TriggerEvent } from '@brigadir/contracts';
import { buildHandoffSection } from './handoff';

/**
 * T011 (US1) + T030 (US3) unit: the handoff builder assembles a bounded markdown
 * block per handoff kind from run/task/roster rows, degrades best-effort on
 * missing source data (FR-013), and returns '' for non-handoff sources. The db
 * is stubbed by inspecting the selected columns (robust to call order).
 */

interface StubData {
  failingRun?: { workspaceId: string; ticketId: string; report: AgentReport | null };
  roster?: Array<{ key: string; name: string; role: string | null; description: string | null }>;
  cycleCount?: number;
  settings?: Record<string, unknown>;
  humanTask?: { title: string; details: string | null };
  // Workspace-setup branch (feature 011 + editable protocol 2026-07-17):
  workspace?: {
    name: string;
    projectKey: string;
    boardType: string | null;
    settings: Record<string, unknown>;
  };
  executors?: Array<{ name: string; type: string; config: Record<string, unknown> | null }>;
  /** Stored `workspace_setup_instruction` global-settings value (unset ⇒ no row). */
  setupInstruction?: string;
}

function makeDb(data: StubData): BrigadirDb {
  const select = (cols: Record<string, unknown>) => {
    const keys = Object.keys(cols ?? {});
    let rows: unknown[] = [];
    if (keys.includes('report')) rows = data.failingRun ? [data.failingRun] : [];
    else if (keys.includes('projectKey')) rows = data.workspace ? [data.workspace] : [];
    else if (keys.includes('config') && keys.includes('type')) rows = data.executors ?? [];
    else if (keys.includes('name') && keys.includes('description')) rows = data.roster ?? [];
    else if (keys.includes('count')) rows = [{ count: data.cycleCount ?? 0 }];
    else if (keys.includes('value'))
      rows = data.setupInstruction ? [{ value: data.setupInstruction }] : [];
    else if (keys.includes('settings')) rows = [{ settings: data.settings ?? {} }];
    else if (keys.includes('title')) rows = data.humanTask ? [data.humanTask] : [];
    const builder = {
      from: () => builder,
      where: () => builder,
      limit: () => Promise.resolve(rows),
      then: (res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows).then(res, rej),
    };
    return builder;
  };
  return { select } as unknown as BrigadirDb;
}

const failingReport: AgentReport = {
  schema_version: 1,
  outcome: 'failure',
  summary: 'Implemented the endpoint but two tests fail.',
  checks: [
    { name: 'tests_pass', status: 'fail', reason: '2 assertions failing' },
    { name: 'lint_pass', status: 'warn', reason: 'one unused import' },
    { name: 'typecheck', status: 'pass' },
  ],
  artifacts: { branch: 'brigadir/PROJ-1', pr_url: 'https://github.com/x/y/pull/3' },
};

const FAILING_RUN_ID = '11111111-1111-4111-8111-111111111111';

describe('buildHandoffSection', () => {
  it('returns "" for non-handoff sources', async () => {
    for (const source of ['manual', 'poll', 'webhook'] as const) {
      const db = makeDb({});
      expect(await buildHandoffSection({ source } as TriggerEvent, db)).toBe('');
    }
    expect(await buildHandoffSection(null, makeDb({}))).toBe('');
    expect(await buildHandoffSection(undefined, makeDb({}))).toBe('');
  });

  describe('triage kind', () => {
    it('renders failing summary, failed/warning checks, artifacts, roster, cycle count, protocol', async () => {
      const db = makeDb({
        failingRun: { workspaceId: 'ws-1', ticketId: 'tk-1', report: failingReport },
        roster: [
          { key: 'developer', name: 'Developer', role: null, description: 'Implements features' },
          { key: 'reviewer', name: 'Reviewer', role: 'QA', description: 'Reviews PRs' },
        ],
        cycleCount: 1,
        settings: { rework_max: 3 },
      });

      const out = await buildHandoffSection(
        { source: 'triage', failing_run_id: FAILING_RUN_ID } as TriggerEvent,
        db,
      );

      expect(out).toContain('## Handoff — triage');
      expect(out).toContain('Failing run: Implemented the endpoint but two tests fail.');
      expect(out).toContain('- tests_pass: fail — 2 assertions failing');
      expect(out).toContain('- lint_pass: warn — one unused import');
      expect(out).not.toContain('typecheck'); // pass checks omitted
      expect(out).toContain('Artifacts: branch brigadir/PROJ-1, PR https://github.com/x/y/pull/3');
      expect(out).toContain('Available worker agents');
      // feature 014: "- <key> — <name>(  (role))?: <description>"
      expect(out).toContain('- developer — Developer: Implements features');
      expect(out).toContain('- reviewer — Reviewer (QA): Reviews PRs');
      expect(out).toContain('Rework cycles used: 1 of 3');
      expect(out).toContain('Decision protocol:');
      expect(out).toContain('routed');
      expect(out).toContain('needs_human');
    });

    it('uses the default rework_max of 2 when unset', async () => {
      const db = makeDb({
        failingRun: { workspaceId: 'ws-1', ticketId: 'tk-1', report: failingReport },
        roster: [{ key: 'developer', name: 'Developer', role: null, description: null }],
        cycleCount: 0,
      });
      const out = await buildHandoffSection(
        { source: 'triage', failing_run_id: FAILING_RUN_ID } as TriggerEvent,
        db,
      );
      expect(out).toContain('Rework cycles used: 0 of 2');
      expect(out).toContain('- developer — Developer'); // null description → key — name
    });

    it('degrades best-effort when the failing run row is missing (no throw)', async () => {
      const db = makeDb({}); // no failingRun
      const out = await buildHandoffSection(
        { source: 'triage', failing_run_id: FAILING_RUN_ID } as TriggerEvent,
        db,
      );
      expect(out).toContain('## Handoff — triage');
      expect(out).toContain('Decision protocol:');
      expect(out).not.toContain('Failing run:'); // omitted, not crashed
      expect(out).not.toContain('Available worker agents');
    });
  });

  describe('rework kind', () => {
    it('renders task, original failure + failed checks, branch/PR, fix-of-existing-work framing', async () => {
      const db = makeDb({
        failingRun: { workspaceId: 'ws-1', ticketId: 'tk-1', report: failingReport },
      });
      const out = await buildHandoffSection(
        {
          source: 'rework',
          failing_run_id: FAILING_RUN_ID,
          deciding_run_id: '22222222-2222-4222-8222-222222222222',
          target_agent: 'Developer',
          task: 'Fix the two failing tests and re-run the suite.',
        } as TriggerEvent,
        db,
      );

      expect(out).toContain('## Handoff — rework (fix of existing work)');
      expect(out).toContain('This is a FIX of existing work');
      expect(out).toContain('Task from the orchestrator:');
      expect(out).toContain('Fix the two failing tests and re-run the suite.');
      expect(out).toContain('Original failure: Implemented the endpoint but two tests fail.');
      expect(out).toContain('- tests_pass: fail — 2 assertions failing');
      expect(out).not.toContain('lint_pass'); // warn is not a fail — rework shows fails only
      expect(out).toContain('Continue on: branch brigadir/PROJ-1, PR https://github.com/x/y/pull/3');
    });
  });

  // Feature 024 (US1): the handoff artifact lines now route through
  // normalizeReportArtifacts, so v2 per-repo reports render one line per repo
  // instead of silently rendering nothing. v1 flat reports (asserted above,
  // lines 102 & 163) must keep their exact single-line form.
  describe('v2 per-repo artifacts (feature 024, US1)', () => {
    const v2Report: AgentReport = {
      schema_version: 2,
      outcome: 'failure',
      summary: 'Multi-repo change; one repo still failing.',
      checks: [{ name: 'tests_pass', status: 'fail', reason: 'boom' }],
      artifacts: {
        repos: [
          { repo: 'product', branch: 'run/T', pr_url: 'https://github.com/x/product/pull/1' },
          { repo: 'infra', branch: 'run/T-infra' },
        ],
      },
    };

    it('rework renders a Continue on: block with one line per reported repo', async () => {
      const db = makeDb({
        failingRun: { workspaceId: 'ws-1', ticketId: 'tk-1', report: v2Report },
      });
      const out = await buildHandoffSection(
        { source: 'rework', failing_run_id: FAILING_RUN_ID, task: 'Fix infra.' } as TriggerEvent,
        db,
      );
      expect(out).toContain('Continue on:');
      expect(out).toContain('- product: branch run/T, PR https://github.com/x/product/pull/1');
      expect(out).toContain('- infra: branch run/T-infra');
      // Not the flat single-line form.
      expect(out).not.toContain('Continue on: branch');
    });

    it('triage renders an Artifacts: block with one line per reported repo', async () => {
      const db = makeDb({
        failingRun: { workspaceId: 'ws-1', ticketId: 'tk-1', report: v2Report },
        roster: [{ key: 'developer', name: 'Developer', role: null, description: null }],
        cycleCount: 0,
      });
      const out = await buildHandoffSection(
        { source: 'triage', failing_run_id: FAILING_RUN_ID } as TriggerEvent,
        db,
      );
      expect(out).toContain('Artifacts:');
      expect(out).toContain('- product: branch run/T, PR https://github.com/x/product/pull/1');
      expect(out).toContain('- infra: branch run/T-infra');
      expect(out).not.toContain('Artifacts: branch');
    });

    it('renders only repos[] when both flat fields and repos[] are present', async () => {
      const both: AgentReport = {
        schema_version: 2,
        outcome: 'failure',
        summary: 's',
        checks: [],
        artifacts: {
          branch: 'FLAT-SHOULD-NOT-APPEAR',
          pr_url: 'https://flat.example/should-not-appear',
          repos: [{ repo: 'product', branch: 'run/T' }],
        },
      };
      const db = makeDb({ failingRun: { workspaceId: 'ws-1', ticketId: 'tk-1', report: both } });
      const out = await buildHandoffSection(
        { source: 'rework', failing_run_id: FAILING_RUN_ID } as TriggerEvent,
        db,
      );
      expect(out).toContain('- product: branch run/T');
      expect(out).not.toContain('FLAT-SHOULD-NOT-APPEAR');
      expect(out).not.toContain('should-not-appear');
    });

    it('renders no artifact line for empty repos[] or absent artifacts', async () => {
      for (const artifacts of [{ repos: [] }, undefined] as const) {
        const rep: AgentReport = {
          schema_version: 2,
          outcome: 'failure',
          summary: 's',
          checks: [],
          ...(artifacts ? { artifacts } : {}),
        };
        const db = makeDb({ failingRun: { workspaceId: 'ws-1', ticketId: 'tk-1', report: rep } });
        const out = await buildHandoffSection(
          { source: 'rework', failing_run_id: FAILING_RUN_ID } as TriggerEvent,
          db,
        );
        expect(out).not.toContain('Continue on:');
        expect(out).not.toContain('- '); // no bulleted artifact line
      }
    });

    it('renders whichever parts exist for a partial v2 entry (pr_url only)', async () => {
      const prOnly: AgentReport = {
        schema_version: 2,
        outcome: 'failure',
        summary: 's',
        checks: [],
        artifacts: { repos: [{ repo: 'product', pr_url: 'https://github.com/x/product/pull/9' }] },
      };
      const db = makeDb({ failingRun: { workspaceId: 'ws-1', ticketId: 'tk-1', report: prOnly } });
      const out = await buildHandoffSection(
        { source: 'rework', failing_run_id: FAILING_RUN_ID } as TriggerEvent,
        db,
      );
      expect(out).toContain('- product: PR https://github.com/x/product/pull/9');
      // The product line carries no branch part (only a PR was reported).
      expect(out).not.toMatch(/- product:.*branch/);
    });
  });

  it('truncates an oversized summary to the budget', async () => {
    const huge = 'x'.repeat(5000);
    const db = makeDb({
      failingRun: {
        workspaceId: 'ws-1',
        ticketId: 'tk-1',
        report: { ...failingReport, summary: huge },
      },
    });
    const out = await buildHandoffSection(
      { source: 'rework', failing_run_id: FAILING_RUN_ID } as TriggerEvent,
      db,
    );
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(huge.length);
  });

  describe('answer-triage kind (answer-triage delta, FR-025)', () => {
    const trigger = {
      source: 'answer-triage',
      failing_run_id: FAILING_RUN_ID,
      human_task_id: '33333333-3333-4333-8333-333333333333',
      resolution: 'Option 1 — the formula is authoritative.',
    } as TriggerEvent;

    it('renders the Q&A, the failure context, the roster, the cycle count, and the protocol', async () => {
      const db = makeDb({
        failingRun: { workspaceId: 'ws-1', ticketId: 'tk-1', report: failingReport },
        roster: [{ key: 'developer', name: 'Developer', role: null, description: 'Implements features' }],
        cycleCount: 1,
        settings: { rework_max: 3 },
        humanTask: { title: 'Formula or example?', details: 'FR-004 contradicts scenario 4.' },
      });

      const out = await buildHandoffSection(trigger, db);

      expect(out).toContain('## Handoff — triage (human answered)');
      expect(out).toContain('Question: Formula or example?');
      expect(out).toContain('FR-004 contradicts scenario 4.');
      expect(out).toContain('Answer: Option 1 — the formula is authoritative.');
      expect(out).toContain('Failing run: Implemented the endpoint but two tests fail.');
      expect(out).toContain('- developer — Developer: Implements features');
      expect(out).toContain('Rework cycles used: 1 of 3');
      expect(out).toContain('Decision protocol:');
      // Budget still available — no grant note.
      expect(out).not.toContain('permits ONE more rework cycle');
    });

    it('states the one-cycle grant when the budget is exhausted', async () => {
      const db = makeDb({
        failingRun: { workspaceId: 'ws-1', ticketId: 'tk-1', report: failingReport },
        roster: [{ key: 'developer', name: 'Developer', role: null, description: null }],
        cycleCount: 2,
        settings: { rework_max: 2 },
        humanTask: { title: 'Q', details: null },
      });
      const out = await buildHandoffSection(trigger, db);
      expect(out).toContain('Rework cycles used: 2 of 2');
      expect(out).toContain(
        'The rework budget above is exhausted, but because a human answered, the system permits ONE more rework cycle for this decision.',
      );
    });

    it('degrades best-effort when the parked run has no report (request_human park)', async () => {
      const db = makeDb({
        humanTask: { title: 'Which auth provider?', details: null },
      });
      const out = await buildHandoffSection(trigger, db);
      expect(out).toContain('## Handoff — triage (human answered)');
      expect(out).toContain('Question: Which auth provider?');
      expect(out).toContain('Answer: Option 1 — the formula is authoritative.');
      expect(out).not.toContain('Failing run:');
      expect(out).toContain('Decision protocol:');
    });
  });

  describe('human-resume kind (T030)', () => {
    it('renders the question title/details and the operator answer verbatim', async () => {
      const db = makeDb({
        humanTask: { title: 'Which staging DB URL?', details: 'The seed script needs a target.' },
      });
      const out = await buildHandoffSection(
        {
          source: 'human-resume',
          human_task_id: '33333333-3333-4333-8333-333333333333',
          resolution: 'Use postgres://staging-db:5432/app',
        } as TriggerEvent,
        db,
      );
      expect(out).toContain('## Handoff — human answer');
      expect(out).toContain('Question: Which staging DB URL?');
      expect(out).toContain('The seed script needs a target.');
      expect(out).toContain('Answer: Use postgres://staging-db:5432/app');
    });
  });

  describe('workspace-setup kind (feature 011 + editable protocol 2026-07-17)', () => {
    const trigger = { source: 'workspace-setup' } as TriggerEvent;
    const workspace = {
      name: 'ST3 Delivery',
      projectKey: 'ST3',
      boardType: 'scrum',
      settings: { repositories: [{ name: 'st3_os' }, { name: 'st3_agentic' }] },
    };

    it('renders the digest and the BUILT-IN protocol when no stored override exists', async () => {
      const db = makeDb({
        workspace,
        executors: [{ name: 'claude', type: 'claude_cli', config: { model: 'claude-sonnet-5' } }],
      });
      const out = await buildHandoffSection(trigger, db, { workspaceId: 'ws-1' });

      // Digest (assembled, not part of the editable text).
      expect(out).toContain('## Workspace setup');
      expect(out).toContain('Jira project ST3');
      expect(out).toContain('Repositories: st3_os (default), st3_agentic');
      expect(out).toContain('- claude — claude_cli (claude-sonnet-5)');
      // Built-in protocol markers: study + repo recon + instruction quality + delivery.
      expect(out).toContain('How to study the project:');
      expect(out).toContain('get_project_overview');
      expect(out).toContain('Recon the CODE, not just the board');
      expect(out).toContain('.specify/memory/constitution.md');
      expect(out).toContain("How to write each agent's instruction");
      expect(out).toContain("the platform performs ALL Jira writes from the worker's final report");
      expect(out).toContain('How to deliver the team:');
      expect(out).toContain('outcome "team"');
    });

    it('renders a STORED protocol override instead of the built-in text', async () => {
      const db = makeDb({
        workspace,
        executors: [],
        setupInstruction: 'CUSTOM PROTOCOL: hire exactly one generalist.',
      });
      const out = await buildHandoffSection(trigger, db, { workspaceId: 'ws-1' });

      expect(out).toContain('## Workspace setup'); // digest intact
      expect(out).toContain('CUSTOM PROTOCOL: hire exactly one generalist.');
      expect(out).not.toContain('How to study the project:');
      expect(out).not.toContain('How to deliver the team:');
    });

    it('returns "" without a workspaceId ctx (best-effort)', async () => {
      const out = await buildHandoffSection(trigger, makeDb({ workspace }), {});
      expect(out).toBe('');
    });

    it('renders the built-in role-template catalog block (feature 030)', async () => {
      const db = makeDb({ workspace, executors: [] });
      const out = await buildHandoffSection(trigger, db, { workspaceId: 'ws-1' });
      expect(out).toContain('Role templates available (source: built-in defaults):');
      expect(out).toContain('- developer');
      expect(out).toContain('(hint: opus)');
      expect(out).toContain('get_role_template(slug)');
      // And the setup instruction learns to use them + map executors by hint.
      expect(out).toContain('How to use role templates:');
      expect(out).toContain("How to choose each agent's executor:");
    });
  });
});
