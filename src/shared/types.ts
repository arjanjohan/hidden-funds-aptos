// Domain contract. Rules behind these fields: docs/left-behind.md.

export type Status = 'recoverable' | 'team_gated' | 'blocked' | 'unknown';
export type AgeBasis = 'onchain_maturity' | 'protocol_closure' | 'position_interaction' | 'unknown';
export type PositionKind = 'principal' | 'fees' | 'reward' | 'request';
export type Confidence = 'verified_view' | 'derived_math' | 'indexer_only';
export type PayoutBasis = 'view' | 'derived' | 'simulated';

/** Raw integer units of one asset; `asset` is a canonical FA metadata address or Coin type. */
export interface Amount { asset: string; raw: string }

export interface Blocker { code: string; detail: string }

/** One recovery stage, descriptive only (read-only product). */
export interface Step {
  function: string;
  arguments: string[];
  prerequisites: string[];
  expectedOutputs: Amount[];
}

export interface Position {
  id: string;                    // source:owner:locator:positionKind[:asset]
  parentId: string;              // source:owner:locator
  source: string;
  owner: string;
  locator: string;
  positionKind: PositionKind;
  asset?: string;
  claimableSince?: string;       // ISO time
  ageBasis: AgeBasis;
  provenance: { reader: string; ledgerVersion: string };
  grossClaim: Amount[];
  expectedPayout: Amount[];
  payoutBasis: PayoutBasis;
  status: Status;
  blockers: Blocker[];
  confidence: Confidence;
  observedAt: string;            // ISO time of the pinned ledger version
  steps: Step[];
}

export interface ReadResult {
  positions: Position[];
  /** False when any read for this owner failed; totals must then treat the owner as unknown. */
  complete: boolean;
  errors: string[];
  ledgerVersion: string;
}

export interface ProtocolStatus {
  state: 'live' | 'deprecated' | 'wound_down' | 'closed';
  evidence: string;
  checkedAt: string;
  effectiveAt?: string;
}

export interface SourceDef<Hint = unknown> {
  id: string;
  chain: 'aptos' | 'movement';
  title: string;
  summary: string;
  category: 'staking' | 'liquid_staking' | 'closed_app';
  /** Which left-behind rule (R2 branch) makes a position count. */
  inclusionRule: string;
  protocolStatus: ProtocolStatus;
  refresh: { nonZero: 'every_run' | 'weekly' | 'monthly'; zero: 'weekly' | 'monthly' };
  /** Age bases this source documents as valid for the headline. */
  headlineAgeBases: AgeBasis[];
  howTo: string[];
  officialUrl?: string;
  /** `hint` lets the pipeline pass enumeration results so the read can skip its own discovery query. */
  read(ctx: ReadContext, owner: string, hint?: Hint): Promise<ReadResult>;
}

export interface Ledger { version: string; timestampSecs: number }

/** Chain access shared by the pipeline (keyed) and the browser (anonymous). */
export interface ChainReader {
  ledger(): Promise<Ledger>;
  view(fn: string, args: unknown[], typeArgs?: string[], ledgerVersion?: string): Promise<any[]>;
  /** Null when the resource does not exist. */
  resource(address: string, type: string, ledgerVersion?: string): Promise<any | null>;
  /** Account authentication key and sequence number; null when the address has no account. */
  account(address: string): Promise<{ authentication_key: string; sequence_number: string } | null>;
  /** A table entry; null when the key is absent. */
  tableItem(handle: string, keyType: string, valueType: string, key: unknown, ledgerVersion?: string): Promise<any | null>;
  /** Historical state older than the fullnode's pruning window. */
  archiveResource(address: string, type: string, ledgerVersion: string): Promise<any | null>;
  gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

/** Memo for derived values that never change for an unchanged position (e.g. claimableSince). */
export interface Memo {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export interface ReadContext {
  chain: ChainReader;
  ledger: Ledger;
  memo: Memo;
  /** Per-run, in-memory: shared reads (pool state, flags) and in-flight promises. */
  scratch: Map<string, Promise<unknown>>;
}
