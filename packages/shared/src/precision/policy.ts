/**
 * How the evidence precision pass is allowed to behave.
 *
 * Deliberately not folded into `ExplorationBudget`. That one is the agent's
 * licence to *read* the repository; this one is a citation policy over evidence
 * already obtained. The precision pass opens no files and spends no tokens, so
 * giving it its own three numbers keeps "how much did we look at" and "how did we
 * cite it" separately answerable.
 */
export interface PrecisionPolicy {
  /**
   * Additional ledger sources the pass may attach to one claim.
   *
   * Zero is the control condition: redundancy removal and ordering still run, but
   * no citation is added, so the iteration's hypothesis can be switched off
   * without switching off the pass.
   */
  maxCorroborations: number;
  /**
   * Distinct claim terms a candidate line must share with the claim before it can
   * be attached. One shared word is a coincidence; the floor is what separates
   * corroboration from keyword collision.
   */
  minCorroborationTerms: number;
  /** Longest excerpt the pass will quote when it attaches a citation. */
  maxCorroborationChars: number;
}

export const DEFAULT_PRECISION_POLICY: PrecisionPolicy = {
  maxCorroborations: 2,
  minCorroborationTerms: 2,
  maxCorroborationChars: 240,
};

/** Policy keys that may legitimately be zero. */
export const PRECISION_ZERO_ALLOWED: ReadonlySet<keyof PrecisionPolicy> = new Set(["maxCorroborations"]);
