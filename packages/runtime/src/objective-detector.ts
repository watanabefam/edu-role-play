import type { ChatMessage, CompositionData, Provider } from "./types";
import { ObjectiveState } from "./types";

/** Each entry is {id, state} where state is 1 (partial) or 2 (complete). */
interface DetectedEntry {
  id: string;
  state: number;
}

/**
 * Parse lines like "ask-contextual-questions: 2" or just "ask-contextual-questions"
 * (no colon = state 2 for backward compatibility).
 * Falls back to JSON array parsing.
 */
function parseEntries(text: string): DetectedEntry[] {
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/\s*```/g, "").trim();

  // Try JSON array first
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        const entries: DetectedEntry[] = [];
        for (const v of parsed) {
          if (v && typeof v === "object") {
            const id = typeof (v as Record<string, unknown>).id === "string" ? (v as Record<string, unknown>).id as string : "";
            const state = Number((v as Record<string, unknown>).state);
            if (id && (state === 1 || state === 2)) entries.push({ id, state });
          }
        }
        if (entries.length > 0) return entries;
      }
    } catch { /* fall through */ }
  }

  // Fallback: line-separated with optional ": state" suffix
  const result: DetectedEntry[] = [];
  for (const line of cleaned.split(/[\n,]+/)) {
    const trimmed = line.replace(/^[-*\d.\s]+/, "").trim();
    if (!trimmed) continue;
    // Check for "id: state" format
    const colon = trimmed.lastIndexOf(":");
    if (colon > 0) {
      const id = trimmed.slice(0, colon).trim();
      const state = Number(trimmed.slice(colon + 1).trim());
      if (id && (state === 1 || state === 2)) {
        result.push({ id, state });
        continue;
      }
    }
    // No colon or unparseable state — default to 2 (complete)
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
    `the PERSONA's responses just provide context. The learner must actively ` +
    `ask, mention, or demonstrate progress — if a topic only came up because ` +
    `the PERSONA brought it up unprompted, that does NOT count.\n\n` +
    `For each objective where the LEARNER has made progress, output:\n` +
    `<id>: <state>\n` +
    `where state is 1 (partial — learner started but hasn't met the full ` +
    `threshold yet) or 2 (complete — threshold fully met).\n` +
    `If an objective requires multiple actions (e.g. "ask at least two ` +
    `questions"), use state 1 when only one action is observed.\n\n` +
    `Objectives:\n${objectiveList}\n\n` +
    `Conversation:\n${transcript}\n\n` +
    `Return ONLY the lines, no other text. Example:\n` +
    `ask-contextual-questions: 2\nexplore-conversion-experience: 1`;

  try {
    const reply = await provider.chat(
      [
        { role: "system", content: "You are an objective tracker. List which objectives have any evidence." },
        { role: "user", content: prompt },
      ],
      { temperature: 0 },
    );
    const entries = parseEntries(reply);
    if (entries.length === 0) return new Map();

    const validIds = new Set(comp.objectives.map((o) => o.id));

    const result: ObjectiveStatusMap = new Map();
    for (const { id, state } of entries) {
      if (!validIds.has(id)) continue;
      result.set(id, { state: state as ObjectiveState, evidence: "detected" });
    }
    return result;
  } catch {
    return new Map();
  }
}
