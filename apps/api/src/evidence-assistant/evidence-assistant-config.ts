/**
 * The evidence assistant's two deployment settings (inc29-evidence-assistant,
 * design D8, C2): read once at boot, in `main.ts`, before Nest starts — a
 * malformed value stops the API from starting, as `service-startup` requires.
 * A hosted environment receives them only through its release (`evidence_assistant`
 * release block); unset, the defaults apply.
 *
 * - `EVIDENCE_ASSISTANT`: `on` (default) or `off`. The switch is an emergency
 *   safety only (INC-2.9 §5, §6): off, no file is read or split, the comparison
 *   answers `{ enabled: false }`, the panel is not shown, and evidence, the
 *   evidence rule and every lifecycle step work as before.
 * - `EVIDENCE_ASSISTANT_TOLERANCE_PERCENT`: a decimal from 0 to 100 with at most
 *   two decimals (default `1`): a fuel line differing from the invoice by at most
 *   this share of the invoice's litres is consistent (INC-2.9 §5, §7; C3).
 */

/** Injection token for the settings (tests pass their own). */
export const EVIDENCE_ASSISTANT_CONFIG = Symbol('EVIDENCE_ASSISTANT_CONFIG');

export class EvidenceAssistantConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceAssistantConfigError';
  }
}

export interface EvidenceAssistantConfig {
  enabled: boolean;
  /** As configured, a decimal string with at most two decimals (`'1'`, `'1.25'`): compared exactly. */
  tolerancePercent: string;
}

export const EVIDENCE_ASSISTANT_DEFAULTS: Readonly<EvidenceAssistantConfig> = Object.freeze({
  enabled: true,
  tolerancePercent: '1',
});

const TOLERANCE = /^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/;

export function readEvidenceAssistantConfig(env: NodeJS.ProcessEnv = process.env): EvidenceAssistantConfig {
  const switchValue = env.EVIDENCE_ASSISTANT;
  if (switchValue !== undefined && switchValue !== 'on' && switchValue !== 'off') {
    throw new EvidenceAssistantConfigError("EVIDENCE_ASSISTANT must be 'on' or 'off'");
  }
  const tolerance = env.EVIDENCE_ASSISTANT_TOLERANCE_PERCENT;
  if (tolerance !== undefined && !TOLERANCE.test(tolerance)) {
    throw new EvidenceAssistantConfigError(
      'EVIDENCE_ASSISTANT_TOLERANCE_PERCENT must be a number from 0 to 100 with at most two decimals, written with a dot',
    );
  }
  return {
    enabled: switchValue !== 'off',
    tolerancePercent: tolerance === undefined ? EVIDENCE_ASSISTANT_DEFAULTS.tolerancePercent : tolerance,
  };
}
