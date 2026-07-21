import type { ChatMessage, CompositionData, ObjectiveState, ObjectiveStatusMap, Provider } from "./types";

function extractJsonObject(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export async function detectCompletedObjectives(
  provider: Provider,
  comp: CompositionData,
  history: ChatMessage[],
): Promise<ObjectiveStatusMap> {
  // Only include objectives not yet complete (skip already-green ones)
  // The caller passes the full history so the detector has enough context.

  const transcript = history
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "LEARNER" : "PERSONA"}: ${m.content}`)
    .join("\n");

  const objectiveList = comp.objectives
    .map((o) => `- ${o.id}: ${o.text}`)
    .join("\n");

  const prompt =
    `Given this conversation transcript and objective list, score each objective:\n\n` +
    `Objectives:\n${objectiveList}\n\nTranscript:\n${transcript}\n\n` +
    `For each objective, return a JSON object keyed by objective id. ` +
    `Each value must have:\n` +
    `- "state": 0 (no evidence), 1 (partial progress, threshold not yet met), or 2 (fully satisfied)\n` +
    `- "evidence": the specific quote(s) from the transcript that support your verdict\n` +
    `- "count": a human-readable summary of progress, e.g. "2 of 2 questions asked" or "1 of 2 required" (omit if not applicable)\n\n` +
    `Example:\n` +
    `{"ask-contextual-questions":{"state":2,"evidence":"Student asked 'What was it like to hear Paul preach?','How did your household react?'","count":"2 of 2 questions"}}\n\n` +
    `Return ONLY the JSON object, no prose.`;

  try {
    const reply = await provider.chat(
      [
        { role: "system", content: "You are an observation grader. Output only JSON." },
        { role: "user", content: prompt },
      ],
      { temperature: 0 },
    );
    const parsed = extractJsonObject(reply) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return new Map();

    const result: ObjectiveStatusMap = new Map();
    for (const [id, val] of Object.entries(parsed)) {
      if (typeof val !== "object" || !val) continue;
      const entry = val as Record<string, unknown>;
      const state = Number(entry.state);
      if (state !== 0 && state !== 1 && state !== 2) continue;
      result.set(id, {
        state: state as ObjectiveState,
        evidence: typeof entry.evidence === "string" ? entry.evidence : "",
        count: typeof entry.count === "string" ? entry.count : undefined,
      });
    }
    return result;
  } catch {
    return new Map();
  }
}
