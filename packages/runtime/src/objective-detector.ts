import type { ChatMessage, CompositionData, Provider } from "./types";
import { ObjectiveState } from "./types";

interface DetectedEntry {
  id: string;
  state: number;
  count?: string;
}

/** Parse line-separated objective IDs. State always defaults to 2 (complete). */
function parseEntries(text: string): DetectedEntry[] {
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/\s*```/g, "").trim();

  // Line-separated format: one ID per line or comma-separated
  const result: DetectedEntry[] = [];
  for (const line of cleaned.split(/[\n,]+/)) {
    let trimmed = line.replace(/^[-*\d.\s<>]+/, "").trim();
    if (!trimmed) continue;
    // Try "id: state" with state override
    const colon = trimmed.lastIndexOf(":");
    if (colon > 0) {
      let id = trimmed.slice(0, colon).trim();
      id = id.replace(/^[^a-zA-Z0-9_]+|[^a-zA-Z0-9_-]+$/g, "");
      let stateRaw = trimmed.slice(colon + 1).trim();
      stateRaw = stateRaw.replace(/^[^\d]+/, "");
      const state = Number(stateRaw);
      if (id && (state >= 0 && state <= 2)) {
        result.push({ id, state: state || 2 });
        continue;
      }
    }
    // Plain ID — state 2 (complete)
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
    `Only the LEARNER's actual questions count. Greetings, pleasantries, ` +
    `and accepting items do NOT count.\n\n` +
    `List the objective IDs where the learner has made any real progress — ` +
    `one per line, no formatting, using the exact ids below.\n` +
    `Include objectives where progress is partial (started but not complete).\n` +
    `Omit objectives with no real progress.\n\n` +
    `Objective ids (use exactly these):\n${comp.objectives.map((o) => o.id).join("\n")}\n\n` +
    `Conversation:\n${transcript}\n\n` +
    `Return ONLY the objective IDs, one per line. Example:\n` +
    `ask-contextual-questions\nexplore-conversion-experience`;

  try {
    const reply = await provider.chat(
      [
        { role: "system", content: "You list objective IDs where the learner made progress." },
        { role: "user", content: prompt },
      ],
      { temperature: 0 },
    );
    let entries = parseEntries(reply);
    // Retry once on parse failure with slight temperature variation
    if (entries.length === 0) {
      const retry = await provider.chat(
        [
          { role: "system", content: "You list objective IDs." },
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
