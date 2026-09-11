import type { HistoryEntry, SearchOptions, TrajectoryEntry } from "ai-hist";

export type { HistoryEntry, TrajectoryEntry } from "ai-hist";
/** Reads cannot widen the current flow's script scope. */
export type MemoryRecallOptions = Omit<SearchOptions, "project">;
export interface MemoryFinding {
  question: string;
  chosen: string;
  reasoning: string;
  alternatives?: string[];
}

export interface MemoryHelper {
  /** Local script memory read; does not journal a step. */
  recall(query: string, options?: MemoryRecallOptions): Promise<HistoryEntry[]>;
  /** Best matching decision trajectory, or an empty array. No journal step. */
  why(task: string): Promise<TrajectoryEntry[]>;
  /** Reserved for the journal-backed write slice; currently refuses. */
  learn(finding: MemoryFinding): Promise<void>;
}
