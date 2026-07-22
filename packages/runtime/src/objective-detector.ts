import type { ChatMessage, CompositionData, Provider } from "./types";
import { ObjectiveState } from "./types";

/**
 * Parse a comma/line-separated list of objective IDs from the LLM reply.
 * Falls back to JSON array parsing for backward compatibility.
 */
function parseIdList(text: string): string[] {
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/\s*```/g, "").trim();

  // Try JSON array first (handles [{"id":"x","state":2},...] format)
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        // Array of objects with id field
        const ids = parsed
          .filter((v: unknown) => v && typeof v === "object" && typeof (v as Record<string, unknown>).id === "string")
          .map((v: unknown) => (v as Record<string, unknown>).id as string)
          .filter(Boolean);
        if (ids.length > 0) return ids;
      }
    } catch { /* fall through */ }
  }

  // Fallback: comma or newline separated list
  const items = cleaned
    .split(/[\n,]+/)
    .map((s) => s.replace(/^[-*\d.\s]+/, "").trim())
    .filter((s) => s.length > 0);
  return items;
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
    `Return the IDs of objectives where the LEARNER actively made progress — ` +
    `one per line, no numbers or bullets.\n` +
    `If an objective requires multiple actions (e.g. "ask at least two ` +
    `questions"), include it even if only partially met.\n\n` +
    `Objectives:\n${objectiveList}\n\n` +
    `Conversation:\n${transcript}\n\n` +
    `Return ONLY the objective IDs where the LEARNER actively made progress, ` +
    `one per line. Example:\n` +
    `ask-contextual-questions\nexplore-conversion-experience`;

  try {
    const reply = await provider.chat(
      [
        { role: "system", content: "You are an objective tracker. List which objectives have any evidence." },
        { role: "user", content: prompt },
      ],
      { temperature: 0 },
    );
    const ids = parseIdList(reply);
    if (ids.length === 0) return new Map();

    // Valid objective IDs from the composition
    const validIds = new Set(comp.objectives.map((o) => o.id));

    const result: ObjectiveStatusMap = new Map();
    for (const id of ids) {
      if (!validIds.has(id)) continue;
      result.set(id, { state: ObjectiveState.Complete, evidence: "detected" });
    }
    return result;
  } catch {
    return new Map();
  }
}
