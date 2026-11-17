import { describe, expect, it } from 'vitest';
import { policyForm, policyFromForm } from './personas';

describe('policyFromForm', () => {
  it('turns tool lines into rules and blank limits into none', () => {
    const policy = policyFromForm({
      mode: 'read_only',
      network: false,
      allowTools: '  Read \n\nBash(cargo test:*)\n',
      denyTools: '',
      maxTurns: '',
      maxBudgetUsd: ' ',
      timeoutMinutes: '',
    });
    expect(policy).toEqual({
      mode: 'read_only',
      network: false,
      allowTools: ['Read', 'Bash(cargo test:*)'],
      denyTools: [],
      maxTurns: null,
      maxBudgetUsd: null,
      timeoutSecs: null,
    });
  });

  it('stores the timeout in seconds and survives a round trip', () => {
    const policy = policyFromForm({
      mode: 'workspace_write',
      network: true,
      allowTools: '',
      denyTools: 'Bash(rm:*)',
      maxTurns: '25',
      maxBudgetUsd: '1.5',
      timeoutMinutes: '30',
    });
    expect(policy).toMatchObject({
      maxTurns: 25,
      maxBudgetUsd: 1.5,
      timeoutSecs: 1_800,
      denyTools: ['Bash(rm:*)'],
    });
    expect(policyFromForm(policyForm(policy))).toEqual(policy);
  });

  it('treats unparsable numbers as no limit instead of NaN', () => {
    expect(
      policyFromForm({
        ...policyForm({ mode: 'full_auto', network: true, allowTools: [], denyTools: [] }),
        maxTurns: 'abc',
      }).maxTurns,
    ).toBeNull();
  });
});
