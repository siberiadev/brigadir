import { describe, it, expect } from 'vitest';
import {
  buildVerificationReceipt,
  matchVerificationReceipt,
  VerificationReceiptSchema,
  VERIFICATION_RECEIPT_MAX_GATES,
  VERIFICATION_RECEIPT_MAX_GATE_NAME,
  type VerificationReceipt,
} from './verification-receipt.schema';
import type { ReportCheck } from './report.schema';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const META = {
  runId: 'run-1',
  agentRole: 'Reviewer',
  agentName: 'Cyrus Smith',
  recordedAt: '2026-07-29T00:00:00.000Z',
};

function check(name: string, status: ReportCheck['status'] = 'pass'): ReportCheck {
  return { name, status };
}

function report(checks: ReportCheck[], outcome = 'success' as const) {
  return { outcome, checks };
}

describe('buildVerificationReceipt', () => {
  it('builds a receipt from pass checks and observed heads', () => {
    const receipt = buildVerificationReceipt(
      report([check('lint'), check('typecheck')]),
      { api: SHA_A, web: SHA_B },
      META,
    );
    expect(receipt).toEqual({
      version: 1,
      runId: 'run-1',
      agentRole: 'Reviewer',
      agentName: 'Cyrus Smith',
      outcome: 'success',
      recordedAt: META.recordedAt,
      gates: ['lint', 'typecheck'],
      repos: { api: SHA_A, web: SHA_B },
    });
  });

  it('keeps only pass checks', () => {
    const receipt = buildVerificationReceipt(
      report([check('lint'), check('e2e', 'fail'), check('build', 'skip'), check('perf', 'warn')]),
      { api: SHA_A },
      META,
    );
    expect(receipt?.gates).toEqual(['lint']);
  });

  it('dedupes gate names', () => {
    const receipt = buildVerificationReceipt(
      report([check('lint'), check('lint'), check(' lint ')]),
      { api: SHA_A },
      META,
    );
    expect(receipt?.gates).toEqual(['lint']);
  });

  it('caps the gate count', () => {
    const checks = Array.from({ length: 20 }, (_, i) => check(`gate-${i}`));
    const receipt = buildVerificationReceipt(report(checks), { api: SHA_A }, META);
    expect(receipt?.gates).toHaveLength(VERIFICATION_RECEIPT_MAX_GATES);
  });

  it('truncates long gate names with an ellipsis', () => {
    const receipt = buildVerificationReceipt(report([check('x'.repeat(200))]), { api: SHA_A }, META);
    expect(receipt?.gates[0]).toHaveLength(VERIFICATION_RECEIPT_MAX_GATE_NAME);
    expect(receipt?.gates[0].endsWith('…')).toBe(true);
  });

  it('returns undefined when there are no pass checks', () => {
    expect(
      buildVerificationReceipt(report([check('e2e', 'fail')]), { api: SHA_A }, META),
    ).toBeUndefined();
  });

  it('returns undefined without observed heads (null or empty)', () => {
    expect(buildVerificationReceipt(report([check('lint')]), null, META)).toBeUndefined();
    expect(buildVerificationReceipt(report([check('lint')]), {}, META)).toBeUndefined();
  });

  it('degrades to undefined instead of persisting a malformed sha', () => {
    expect(
      buildVerificationReceipt(report([check('lint')]), { api: 'not-a-sha' }, META),
    ).toBeUndefined();
  });

  it('carries a failure outcome (receipts are written on all report outcomes)', () => {
    const receipt = buildVerificationReceipt(
      { outcome: 'failure', checks: [check('lint')] },
      { api: SHA_A },
      META,
    );
    expect(receipt?.outcome).toBe('failure');
  });

  it('keeps a null agent role (role-less agents)', () => {
    const receipt = buildVerificationReceipt(report([check('lint')]), { api: SHA_A }, {
      ...META,
      agentRole: null,
    });
    expect(receipt?.agentRole).toBeNull();
  });
});

describe('matchVerificationReceipt', () => {
  const receipt: VerificationReceipt = VerificationReceiptSchema.parse({
    version: 1,
    runId: 'run-1',
    agentRole: 'Developer',
    agentName: 'Nemo',
    outcome: 'success',
    recordedAt: META.recordedAt,
    gates: ['lint'],
    repos: { api: SHA_A, web: SHA_B },
  });

  it('matches when every mounted repo is at the recorded sha', () => {
    expect(matchVerificationReceipt(receipt, { api: SHA_A, web: SHA_B })).toEqual(receipt);
  });

  it('rejects on a sha mismatch in any repo', () => {
    expect(matchVerificationReceipt(receipt, { api: SHA_A, web: SHA_A })).toBeUndefined();
  });

  it('rejects when a mounted repo is missing from the receipt', () => {
    expect(
      matchVerificationReceipt(receipt, { api: SHA_A, web: SHA_B, infra: SHA_A }),
    ).toBeUndefined();
  });

  it('rejects when the receipt names a repo that is not mounted (whole-workspace only)', () => {
    expect(matchVerificationReceipt(receipt, { api: SHA_A })).toBeUndefined();
  });

  it('rejects with no mounted repos', () => {
    expect(matchVerificationReceipt(receipt, {})).toBeUndefined();
  });

  it('degrades on garbage jsonb, null, and legacy shapes', () => {
    expect(matchVerificationReceipt(null, { api: SHA_A })).toBeUndefined();
    expect(matchVerificationReceipt(undefined, { api: SHA_A })).toBeUndefined();
    expect(matchVerificationReceipt('garbage', { api: SHA_A })).toBeUndefined();
    expect(matchVerificationReceipt({ version: 2, repos: {} }, { api: SHA_A })).toBeUndefined();
  });
});
