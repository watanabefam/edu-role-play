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

  // Build rubric reference map: objectiveId → full credit description
  const rubricMap = new Map<string, string>();
  for (const c of comp.rubric) {
    rubricMap.set(c.objectiveId, c.text);
  }

  const objectivesWithRef = comp.objectives
    .map((o) => {
      const ref = rubricMap.get(o.id);
      return ref ? `- ${o.id}: ${o.text}\n  Full credit looks like: ${ref}` : `- ${o.id}: ${o.text}`;
    })
    .join("\n");

  const prompt =
    `Only the LEARNER's actual questions or statements count. Greetings, ` +
    `pleasantries, and accepting offered items do NOT count.\n\n` +
    `For each objective below, compare what the learner actually said against ` +
    `the full credit description. List the objective ID if the learner has made ` +
    `any real progress toward it — even if partial.\n` +
    `Omit objectives where the learner has not demonstrated any real progress ` +
    `toward the described standard.\n\n` +
    `Objectives with full credit reference:\n${objectivesWithRef}\n\n` +
    `Conversation:\n${transcript}\n\n` +
    `Return ONLY the objective IDs where progress exists, one per line.\n` +
    `Example:\n` +
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
