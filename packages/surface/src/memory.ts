import type { SearchOptions, SessionLocation, Source } from "ai-hist";

/**
 * One history row from `recall`. A learned finding that is not in the
 * ai-hist database uses `source: "trajectory"` and a negative `id`.
 */
export interface HistoryEntry {
  id: number;
  source: Source | "trajectory";
  sessionId: string | null;
  project: string | null;
  prompt: string;
  timestampMs: number;
  locations: SessionLocation[];
}

/** One decision inside a learned trajectory. */
export interface TrajectoryDecision {
  question: string;
  chosen: string;
  reasoning: string;
  alternatives: string[];
}

/**
 * A decision record `why` reads from this flow's learned files.
 * ai-hist 0.63 no longer exports this type or stores trajectories.
 */
export interface TrajectoryEntry {
  id: string;
  version: number;
  personaId: string | null;
  projectId: string;
  task: { title: string | null; description: string | null };
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  decisions: TrajectoryDecision[];
  retrospective: {
    summary: string | null;
    approach: string | null;
    learnings: string[];
    confidence: string | null;
  };
  searchText: string;
  path: string;
  updatedMs: number;
  timestampMs: number;
}

/** Reads cannot widen the current flow's script scope or choose another database. */
export type MemoryRecallOptions = Omit<SearchOptions, "project" | "dbPath">;

export interface MemoryFinding {
  question: string;
  chosen: string;
  reasoning: string;
  alternatives?: string[];
}

export interface MemoryHelper {
  /** Local script memory read; does not journal a step. */
  recall(query: string, options?: MemoryRecallOptions): Promise<HistoryEntry[]>;
  /** Newest learned decision for this script scope, or an empty array. No journal step. */
  why(task: string): Promise<TrajectoryEntry[]>;
  /** Journals the finding on the durable root run, then persists it to this flow's script memory; later runs see it via recall/why. Idempotent per finding. Must be awaited. */
  learn(finding: MemoryFinding): Promise<void>;
}
