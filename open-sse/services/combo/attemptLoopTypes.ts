/**
 * Shared types for the handleComboChat attempt-loop split (ROADMAP 3.8.52).
 *
 * Mutable loop state lives on AttemptLoopState. Read-only dependencies live on
 * AttemptLoopDeps. Do not merge the two into ComboContext.
 *
 * @internal — not part of the public combo.ts barrel.
 */
import type { PerTargetAdmissionHook } from "../admission/types.ts";
import type { CliproxyManagementHealthCache } from "../../../src/lib/services/cliproxyManagementPreflight.ts";
import type { ResilienceSettings } from "../../../src/lib/resilience/settings";
import type { ContextRelayConfig, UniversalHandoffConfig } from "../contextHandoff.ts";
import type { ComboErrorEntry } from "./comboErrorAggregation.ts";
import type { ResetWindowConfig } from "./quotaScoring.ts";
import type { ResponseValidationConfig } from "./responseValidation.ts";
import type { ApplyStickinessResult } from "./sessionStickiness.ts";
import type {
  ComboLike,
  ComboLogger,
  ComboRetryAfter,
  HandleSingleModel,
  IsModelAvailable,
  ResolvedComboTarget,
} from "./types.ts";

export type ExecuteTargetResult = { ok: boolean; response?: Response } | null;

export type AttemptLoopState = {
  orderedTargets: ResolvedComboTarget[];
  fallbackCount: number;
  recordedAttempts: number;
  comboErrors: ComboErrorEntry[];
  lastError: string | null;
  lastStatus: number | null;
  earliestRetryAfter: ComboRetryAfter | null;
  /** Deadline from a target skipped by the credential availability gate. */
  skippedConnectionCooldownUntil?: number;
  comboExpired: boolean;
  exhaustedProviders: Set<string>;
  exhaustedConnections: Set<string>;
  transientRateLimitedProviders: Set<string>;
  abortControllers: Map<number, AbortController>;
  dispatchedTargets: Set<string>;
  targetFailureTrust: Map<string, { observedFailure: boolean; allObservedFailuresQuota: boolean }>;
  comboAttemptOrder: Array<{ provider: string; model: string }>;
  skippedForCircuitOpen: boolean;
  earliestCircuitOpenRetryMs: number;
  /** Mutable attempt budget shared with dispatchWithCooldownRetry (Task 4). */
  globalAttempts: number;
  /** nnd.20: readiness-deadline failure budget counter — consumed in
   * executeTargetAttempt's failure classification; init/reset with the loop. */
  deadlineFailures: number;
  /** Quota-trust accumulators; persist across set retries and cooldown re-dispatch. */
  observedFailure: boolean;
  allObservedFailuresQuota: boolean;
  requestScopedFailureSeen: boolean;
  /** Normalized provider/model keys already refused request-scoped this dispatch. */
  requestScopedRejectedModelKeys?: Set<string>;
  /**
   * nnd.44 ③ (#213): one-shot latch — set the moment a last-resort dispatch
   * fires (both terminal exits share it; a request pays for at most one).
   */
  lastResortFired?: boolean;
  /**
   * nnd.44 ③ (#213): true ONLY while a last-resort dispatch is being gated/
   * executed — the persisted-cooldown gate reads it to exempt future EPOCH
   * cooldowns (encoding-aware). Never persists past the attempt.
   */
  lastResortPass?: boolean;
  observeFailure(quotaExhausted: boolean, targetExecutionKey?: string): void;
};

export type AttemptLoopDeps = {
  strategy: string;
  combo: ComboLike;
  config: Record<string, unknown> & {
    zeroLatencyOptimizationsEnabled?: boolean;
    responseValidation?: ResponseValidationConfig | null;
    failoverBeforeRetryExplicit?: boolean;
    failoverBeforeRetry?: boolean;
    predictiveTtftMs?: number;
    fallbackCompressionMode?: string;
    fallbackCompressionThreshold?: number;
    retryDelayMs?: number;
    fallbackDelayMs?: number;
    maxGlobalAttempts?: unknown;
    hedging?: boolean;
    hedgeDelayMs?: unknown;
  };
  log: ComboLogger;
  settings: Record<string, unknown> | null;
  resilienceSettings: ResilienceSettings;
  sticky: ApplyStickinessResult;
  effectiveSessionId: string | null;
  preScreenMap: Map<string, { profile?: unknown }>;
  quotaCutoffResetWindowConfig: ResetWindowConfig;
  maxRetries: number;
  traceInvocationId: string;
  clientRequestedStream: boolean;
  handleSingleModelWithTimeout: HandleSingleModel;
  requestHeaders?: Headers | Record<string, unknown> | null;
  isModelAvailable?: IsModelAvailable;
  perTargetAdmission?: PerTargetAdmissionHook | null;
  /** Optional only to permit deterministic management-health gate tests. */
  cliproxyManagementHealthCache?: CliproxyManagementHealthCache;
  signal?: AbortSignal | null;
  body: Record<string, unknown>;
  startTime: number;
  releaseStickyPinOnFailure: (
    messageHash: string | null | undefined,
    failedConnectionId: string | null | undefined
  ) => void;
  clearStaleLKGP: (
    comboName: string,
    executionKey: string | undefined,
    comboId: string | undefined,
    log: ComboLogger,
    tag: string,
    /** Test seam, unused on the routing path; see staleLkgpClear.ts. */
    clearLKGP?: ((comboName: string, modelKey: string) => Promise<void>) | undefined,
    failed?: { provider?: string | null; connectionId?: string | null } | null
  ) => void;
  /**
   * Closed-over setup values from handleComboChatInner. Optional so Task 2
   * gate tests keep compiling; attempt uses defaults when absent.
   */
  clientManagedResponsesContext?: boolean;
  nativeCodexAutoResume?: boolean;
  reasoningTokenBufferEnabled?: boolean;
  stickyWeightedLimit?: number;
  getWeightedStepKeyForTarget?: (target: ResolvedComboTarget) => string | null;
  universalHandoffConfig?: UniversalHandoffConfig;
  sourceFormat?: string | null;
  relayOptions?: { sessionId?: string | null } | null;
  relayConfig?: ContextRelayConfig | null;
};

export type GateDecision =
  | { kind: "skip"; result: ExecuteTargetResult }
  | {
      kind: "proceed";
      targetForAttempt: ResolvedComboTarget;
      profile: unknown;
      protectedPriorityTarget: boolean;
    };

export interface ExecuteTargetAttemptOptions {
  index: number;
  state: AttemptLoopState;
  deps: AttemptLoopDeps;
  targetForAttempt: ResolvedComboTarget;
  profile: unknown;
  protectedPriorityTarget: boolean;
  /**
   * nnd.44 ③ (#213): this attempt is the request's single last-resort
   * dispatch. Sanctioned effects: the nnd.42d model-lock pre-dispatch guard
   * releases (it would re-skip the very lock being retried past) and the
   * retry loop is clamped to a single pass (cost ceiling ≤ 1 upstream
   * attempt). All other guards still apply.
   */
  lastResort?: boolean;
}
