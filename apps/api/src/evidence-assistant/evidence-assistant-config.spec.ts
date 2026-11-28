import { describe, expect, it } from 'vitest';
import { EvidenceAssistantConfigError, readEvidenceAssistantConfig } from './evidence-assistant-config';

/** inc29-evidence-assistant task 6.1: the two settings, read once at boot (D8). */
describe('readEvidenceAssistantConfig', () => {
  it('defaults to on at 1 percent', () => {
    expect(readEvidenceAssistantConfig({})).toEqual({ enabled: true, tolerancePercent: '1' });
  });

  it('reads on and off', () => {
    expect(readEvidenceAssistantConfig({ EVIDENCE_ASSISTANT: 'on' }).enabled).toBe(true);
    expect(readEvidenceAssistantConfig({ EVIDENCE_ASSISTANT: 'off' })).toEqual({ enabled: false, tolerancePercent: '1' });
  });

  it.each(['true', 'OFF', '0', '', ' off'])('refuses the switch %j', (value) => {
    expect(() => readEvidenceAssistantConfig({ EVIDENCE_ASSISTANT: value })).toThrow(EvidenceAssistantConfigError);
  });

  it.each(['0', '1.25', '100', '0.5', '99.99', '100.00', '7'])('accepts the tolerance %s', (value) => {
    expect(readEvidenceAssistantConfig({ EVIDENCE_ASSISTANT_TOLERANCE_PERCENT: value }).tolerancePercent).toBe(value);
  });

  it.each(['1.255', '-1', '101', '1,5', '', '1e1', '100.01', ' 1', '.5', '1.', 'NaN'])('refuses the tolerance %j', (value) => {
    expect(() => readEvidenceAssistantConfig({ EVIDENCE_ASSISTANT_TOLERANCE_PERCENT: value })).toThrow(/0 to 100 with at most two decimals/);
  });
});
