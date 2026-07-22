import type { ChatMessage, CompositionData, Provider } from "./types";
import { ObjectiveState } from "./types";

interface DetectedEntry {
  id: string;
  state: number;
  count?: string;
}

/** Parse JSON array or fallback line format. */
function parseEntries(text: string): DetectedEntry[] {
  const cleaned = text.replace(/```(?:json)?\s*/gi, "").replace(/\s*```/g, "").trim();

  // Try JSON array of objects: [{"id":"x","state":1,"scores":[70,85]}]
  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        const entries: DetectedEntry[] = [];
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const id = String((item as Record<string, unknown>).id || "");
          const state = Number((item as Record<string, unknown>).state);
          if (!id || (state !== 1 && state !== 2)) continue;
          const scores = (item as Record<string, unknown>).scores;
          const count = Array.isArray(scores) ? scores.join(",") : undefined;
          entries.push({ id, state, count });
        }
        if (entries.length > 0) return entries;
      }
    } catch { /* fall through */ }
  }

  // Fallback: line-separated format (backward compat)
  const result: DetectedEntry[] = [];
  for (const line of cleaned.split(/[\n,]+/)) {
    let trimmed = line.replace(/^[-*\d.\s<>]+/, "").trim();
    if (!trimmed) continue;
    let count: string | undefined;
    const pipeIdx = trimmed.lastIndexOf("|");
    if (pipeIdx > 0) {
      const suffix = trimmed.slice(pipeIdx + 1).trim();
      if (/^\d+(\.\d+)?(\s*,\s*\d+(\.\d+)?)*$/.test(suffix) || /^\d+\s*\/\s*\d+$/.test(suffix)) {
        count = suffix;
        trimmed = trimmed.slice(0, pipeIdx).trim();
      }
    }
    const colon = trimmed.lastIndexOf(":");
    if (colon > 0) {
      let id = trimmed.slice(0, colon).trim();
      id = id.replace(/^[^a-zA-Z0-9_]+|[^a-zA-Z0-9_-]+$/g, "");
      let stateRaw = trimmed.slice(colon + 1).trim();
      stateRaw = stateRaw.replace(/^[^\d]+/, "");
      const state = Number(stateRaw);
      if (id && (state === 1 || state === 2)) {
        result.push({ id, state, count });
        continue;
      }
    }
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
    `You are grading a student interviewing a historical figure.\n` +
    `Only the LEARNER's (student's) actual questions and statements count as evidence.` +
    `Greetings, pleasantries, and accepting offered items do NOT count.\n\n` +
    `For each objective, decide if the LEARNER asked substantive questions or made ` +
    `specific, relevant statements that demonstrate progress.\n` +
    `Return a JSON array: [{"id":"...","state":1|2,"scores":[per-item 0-100]}]\n` +
    `state=1 means some progress but below threshold. state=2 means threshold met.\n` +
    `Omit objectives where the learner has not demonstrated any real progress.\n\n` +
    `Example:\n` +
    `[{"id":"ask-contextual-questions","state":1,"scores":[70]}]\n\n` +
    `Objectives:\n${objectiveList}\n\n` +
    `Conversation:\n${transcript}`;

  try {
    const reply = await provider.chat(
      [
        { role: "system", content: "You return JSON arrays of objective assessments." },
        { role: "user", content: prompt },
      ],
      { temperature: 0, jsonMode: true },
    );
    let entries = parseEntries(reply);
    // Retry once on parse failure
    if (entries.length === 0) {
      const retry = await provider.chat(
        [
          { role: "system", content: "You return JSON arrays of objective assessments." },
          { role: "user", content: prompt },
        ],
        { temperature: 0.1, jsonMode: true },
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
