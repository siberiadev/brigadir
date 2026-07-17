import { describe, it, expect } from 'vitest';
import {
  BrigadirAgentTemplateSchema,
  BrigadirAgentSettingsSchema,
  BRIGADIR_AGENT_TEMPLATE_KEY,
} from './orchestrator-template.schema';
import {
  DEFAULT_BRIGADIR_AGENT_TEMPLATE,
  DEFAULT_ORCHESTRATOR_INSTRUCTION,
  DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
} from './orchestrator-defaults';

/** A fresh, mutable copy of the built-in default template. */
function defaultTemplate() {
  return structuredClone(DEFAULT_BRIGADIR_AGENT_TEMPLATE) as Record<string, unknown>;
}

describe('BrigadirAgentTemplateSchema', () => {
  it('parses the built-in default template (defaults and schema never drift apart)', () => {
    const res = BrigadirAgentTemplateSchema.safeParse(DEFAULT_BRIGADIR_AGENT_TEMPLATE);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.name).toBe('brigadir');
      expect(res.data.triage.executor).toBe('brigadir-orchestrator');
      expect(res.data.setup.executor).toBe('brigadir-setup');
      expect(res.data.setup.timeout_minutes).toBe(60);
    }
  });

  it('pins the storage key', () => {
    expect(BRIGADIR_AGENT_TEMPLATE_KEY).toBe('brigadir_agent_template');
  });

  it('requires schema_version to be the literal 1', () => {
    expect(
      BrigadirAgentTemplateSchema.safeParse({ ...defaultTemplate(), schema_version: 2 }).success,
    ).toBe(false);
  });

  it('rejects out-of-bounds limits (mirrors AgentWriteRequestSchema bounds)', () => {
    for (const bad of [
      { timeout_minutes: 0 },
      { timeout_minutes: 1.5 },
      { max_attempts: 0 },
      { max_budget_usd: -1 },
      { max_budget_usd: 0 },
    ]) {
      const res = BrigadirAgentTemplateSchema.safeParse({ ...defaultTemplate(), ...bad });
      expect(res.success, JSON.stringify(bad)).toBe(false);
    }
    // null budget is the valid "no cap".
    expect(
      BrigadirAgentTemplateSchema.safeParse({ ...defaultTemplate(), max_budget_usd: null })
        .success,
    ).toBe(true);
  });

  it('rejects empty identity fields and empty executor names', () => {
    expect(BrigadirAgentTemplateSchema.safeParse({ ...defaultTemplate(), name: '' }).success).toBe(
      false,
    );
    expect(BrigadirAgentTemplateSchema.safeParse({ ...defaultTemplate(), role: '' }).success).toBe(
      false,
    );
    const noTriageExecutor = defaultTemplate();
    noTriageExecutor.triage = { executor: '', behavior: {} };
    expect(BrigadirAgentTemplateSchema.safeParse(noTriageExecutor).success).toBe(false);
  });

  it('is strict at every level (unknown keys rejected) while behavior passes through', () => {
    expect(
      BrigadirAgentTemplateSchema.safeParse({ ...defaultTemplate(), surprise: true }).success,
    ).toBe(false);

    const strangeSetup = defaultTemplate();
    strangeSetup.setup = { executor: 'brigadir-setup', behavior: {}, timeout_minutes: 60, x: 1 };
    expect(BrigadirAgentTemplateSchema.safeParse(strangeSetup).success).toBe(false);

    // Behavior objects round-trip unknown keys (analysis U1).
    const richBehavior = defaultTemplate();
    richBehavior.triage = {
      executor: 'brigadir-orchestrator',
      behavior: { workspace_mode: 'none', allowed_tools: ['Bash'], custom_flag: 1 },
    };
    const res = BrigadirAgentTemplateSchema.safeParse(richBehavior);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.triage.behavior).toMatchObject({ allowed_tools: ['Bash'], custom_flag: 1 });
    }
  });

  it('rejects corrupt inputs (non-object, missing sub-profiles)', () => {
    for (const corrupt of ['"a string"', 42, null, [], { schema_version: 1 }]) {
      expect(BrigadirAgentTemplateSchema.safeParse(corrupt).success).toBe(false);
    }
    const noSetup = defaultTemplate();
    delete noSetup.setup;
    expect(BrigadirAgentTemplateSchema.safeParse(noSetup).success).toBe(false);
  });
});

describe('BrigadirAgentSettingsSchema', () => {
  const validSettings = () => ({
    template: defaultTemplate(),
    routing_instruction: DEFAULT_ORCHESTRATOR_INSTRUCTION,
    workspace_setup_instruction: DEFAULT_WORKSPACE_SETUP_INSTRUCTION,
  });

  it('parses the composed default payload', () => {
    expect(BrigadirAgentSettingsSchema.safeParse(validSettings()).success).toBe(true);
  });

  it('caps instruction length at 20000 and rejects empty texts', () => {
    expect(
      BrigadirAgentSettingsSchema.safeParse({
        ...validSettings(),
        routing_instruction: 'x'.repeat(20001),
      }).success,
    ).toBe(false);
    expect(
      BrigadirAgentSettingsSchema.safeParse({ ...validSettings(), workspace_setup_instruction: '' })
        .success,
    ).toBe(false);
  });

  it('is strict (unknown top-level keys rejected)', () => {
    expect(
      BrigadirAgentSettingsSchema.safeParse({ ...validSettings(), theme: 'dark' }).success,
    ).toBe(false);
  });
});
