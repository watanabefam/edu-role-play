import type { ChatMessage, CompositionData, Provider } from "./types";
import { ObjectiveState } from "./types";

interface DetectedEntry {
  id: string;
  state: number;
  count?: string;
}

/** Parse lines like "id: 2" or "id: 1", or just IDs. Falls back to JSON parsing. */
function parseEntries(text: string): DetectedEntry[] {
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/\s*```/g, "").trim();

  // Try JSON array first
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        // Array of strings
        const ids = parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
        if (ids.length > 0) return ids;
      }
    } catch { /* fall through */ }
  }

  // Fallback: line-separated with optional ":state | N/M" suffix
  const result: DetectedEntry[] = [];
  for (const line of cleaned.split(/[\n,]+/)) {
    let trimmed = line.replace(/^[-*\d.\s<>]+/, "").trim();
    if (!trimmed) continue;
    // Extract per-item scores after "|" if present (e.g. "| 70,85")
    let count: string | undefined;
    const pipeIdx = trimmed.lastIndexOf("|");
    if (pipeIdx > 0) {
      const suffix = trimmed.slice(pipeIdx + 1).trim();
      // Check for comma-separated scores like "70,85" or "N/M" format
      if (/^\d+(\.\d+)?(\s*,\s*\d+(\.\d+)?)*$/.test(suffix) || /^\d+\s*\/\s*\d+$/.test(suffix)) {
        count = suffix;
        trimmed = trimmed.slice(0, pipeIdx).trim();
      }
    }
    // Try "id: state" format
    const colon = trimmed.lastIndexOf(":");
    if (colon > 0) {
      let id = trimmed.slice(0, colon).trim();
      id = id.replace(/^[^a-zA-Z0-9_]+|[^a-zA-Z0-9_-]+$/g, "");
      let stateRaw = trimmed.slice(colon + 1).trim();
      // Strip "STATE=" or other non-numeric prefixes the LLM sometimes adds
      stateRaw = stateRaw.replace(/^[^\d]+/, "");
      const state = Number(stateRaw);
      if (id && (state === 1 || state === 2)) {
        result.push({ id, state, count });
        continue;
      }
    }
    // Plain ID — default to state 2 (complete) for backward compat
    result.push({ id: trimmed, state: 2 });
  }
  return result;
}

export async function detectCompletedObjectives(
  provider: Provider,
  comp: CompositionData,
  history: ChatMessage[],
): Promise<ObjectiveStatusMap> {
  const transcript = history
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "LEARNER" : "PERSONA"}: ${m.content}`)
    .join("\n");

  const objectiveList = comp.objectives
    .map((o) => `- ${o.id}: ${o.text}`)
    .join("\n");

  const prompt =
    `Review the conversation below. Only LEARNER messages count as evidence — ` +
    `the PERSONA's responses just provide context.\n\n` +
    `For each objective, assess BOTH quantity AND quality:\n` +
    `STATE=1 — below threshold (low quality or insufficient quantity)\n` +
    `STATE=2 — threshold met AND quality good\n` +
    `Omit objectives with no evidence.\n\n` +
    `When an objective involves counting, append per-item quality scores: ` +
    `id: STATE | score1,score2,...\n` +
    `Each score is 0-100 reflecting quality of that specific action.\n` +
    `Example: ask-contextual-questions: 1 | 70,85\n` +
    `(means 2 questions: first 70% quality, second 85% quality)\n\n` +
    `Objectives:\n${objectiveList}\n\n` +
    `Conversation:\n${transcript}\n\n` +
    `Example:\n` +
    `ask-contextual-questions: 2\nexplore-conversion-experience: 1`;

  try {
    const reply = await provider.chat(
      [
        { role: "system", content: "You are an objective tracker. List which objectives have any evidence." },
        { role: "user", content: prompt },
      ],
      { temperature: 0 },
    );
    let entries = parseEntries(reply);
    // Retry once on parse failure with slightly higher temperature
    if (entries.length === 0) {
      const retry = await provider.chat(
        [
          { role: "system", content: "You are an objective tracker." },
          { role: "user", content: prompt },
        ],
        { temperature: 0.1 },
      );
      entries = parseEntries(retry);
    }
    if (entries.length === 0) return new Map();

    const validIds = new Set(comp.objectives.map((o) => o.id));

    const result: ObjectiveStatusMap = new Map();
    for (const { id, state, count } of entries) {
      if (!validIds.has(id)) continue;
      result.set(id, { state: state as ObjectiveState, evidence: "detected", count });
    }
    return result;
  } catch {
    return new Map();
  }
}
