import type { ChatMessage, CompositionData, Provider } from "./types";
import { ObjectiveState } from "./types";

/**
 * Parse a comma/line-separated list of objective IDs.
 * Falls back to JSON array parsing.
 */
function parseIdList(text: string): string[] {
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

  // Fallback: comma or newline separated list
  return cleaned
    .split(/[\n,]+/)
    .map((s) => s.replace(/^[-*\d.\s<>]+/, "").trim())
    .filter((s) => s.length > 0);
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
    `Return the IDs of objectives where the LEARNER has made any active ` +
    `progress — one per line, no numbers, bullets, or colons.\n\n` +
    `Objectives:\n${objectiveList}\n\n` +
    `Conversation:\n${transcript}\n\n` +
    `Return ONLY the IDs, one per line. Example:\n` +
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
