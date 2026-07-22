import type { ChatMessage, CompositionData, Provider } from "./types";
import { ObjectiveState } from "./types";

interface DetectedEntry {
  id: string;
  state: number;
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

  // Fallback: line-separated with optional ":state" suffix
  const result: DetectedEntry[] = [];
  for (const line of cleaned.split(/[\n,]+/)) {
    let trimmed = line.replace(/^[-*\d.\s<>]+/, "").trim();
    if (!trimmed) continue;
    // Try "id: state" format
    const colon = trimmed.lastIndexOf(":");
    if (colon > 0) {
      let id = trimmed.slice(0, colon).trim();
      id = id.replace(/^[^a-zA-Z0-9_]+|[^a-zA-Z0-9_-]+$/g, "");
      const state = Number(trimmed.slice(colon + 1).trim());
      if (id && (state === 1 || state === 2)) {
        result.push({ id, state });
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
    `For each objective, rate the learner's best contribution:\n` +
    `STATE=1 — touched on it, but vague/barely/tangential/low quality\n` +
    `STATE=2 — clearly met with specific, on-topic, quality contribution\n` +
    `Omit objectives with no evidence at all.\n\n` +
    `Output format: id: STATE (one per line)\n\n` +
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
