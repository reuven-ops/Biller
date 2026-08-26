// PHI screen (brief section 15.1): regex checks plus a MODEL_LIGHT classification,
// combined with OR. Under PHI_MODE=deny a positive screen refuses the question and
// the text is never persisted.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmClient } from './llm.js';
import { modelConfig } from './llm.js';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

export function promptText(name: string): string {
  return readFileSync(join(PROMPTS_DIR, name), 'utf8');
}

export function promptVersion(text: string): string {
  return /prompt_version:\s*([\w.-]+)/.exec(text)?.[1] ?? 'unknown';
}

export interface PhiScreenResult {
  phi: boolean;
  categories: string[];
  method: 'regex' | 'model' | 'both' | 'none';
}

const REGEX_CHECKS: [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b/, 'ssn'],
  [/\b(dob|date of birth|born)\b[\s:]*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/i, 'dob'],
  [/\b(member|subscriber|policy)\s*(id|number|#)\s*[:#]?\s*[A-Z0-9]{6,}/i, 'member_id'],
  [/\bmrn\s*[:#]?\s*[A-Z0-9]{5,}/i, 'mrn'],
  [/\b[Pp]atient\s+(name\s*:|[A-Z][a-z]+\s+[A-Z][a-z]+\b)/, 'name'],
];

export function phiRegexScreen(text: string): string[] {
  const hits: string[] = [];
  for (const [re, category] of REGEX_CHECKS) {
    if (re.test(text)) hits.push(category);
  }
  return hits;
}

export async function phiScreen(llm: LlmClient, text: string): Promise<PhiScreenResult> {
  const regexHits = phiRegexScreen(text);
  let modelPhi = false;
  let modelCategories: string[] = [];
  if (llm.mode === 'live') {
    const prompt = promptText('phi_screen.md');
    const res = await llm.complete({
      model: modelConfig().light,
      system: prompt,
      messages: [{ role: 'user', content: text }],
      maxTokens: 256,
    });
    const textOut = res.content.find((b) => b.type === 'text');
    if (textOut && textOut.type === 'text') {
      try {
        const parsed = JSON.parse(textOut.text.replace(/^[^{]*/, '').replace(/[^}]*$/, '')) as {
          phi?: boolean;
          categories?: string[];
        };
        modelPhi = parsed.phi === true;
        modelCategories = parsed.categories ?? [];
      } catch {
        // Unparseable screen output: fail closed only if regex also hit.
      }
    }
  }
  const phi = regexHits.length > 0 || modelPhi;
  const categories = [...new Set([...regexHits, ...modelCategories])];
  const method =
    regexHits.length > 0 && modelPhi
      ? 'both'
      : regexHits.length > 0
        ? 'regex'
        : modelPhi
          ? 'model'
          : 'none';
  return { phi, categories, method };
}
