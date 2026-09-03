import { validateNamespace } from "./memory-scopes.js";

const DREAM_COLLECTION_PREFIX = "dream:";

const DREAM_PATTERN_RULES: Array<{ label: string; patterns: RegExp[] }> = [
  {
    label: "dream",
    patterns: [
      // Direct questions about dreams / dreaming (memory-recall intent)
      /\btell\s+me\s+about\s+(?:your\s+)?dreams?\b/i,
      /\bwhat\s+did\s+i\s+dream\s+about\b/i,
      /\bwhat\s+was\s+i\s+dreaming\s+about\b/i,
      /\b(?:do\s+you\s+)?remember\s+(?:\w+\s+)?(?:the\s+)?dreams?\b/i,
      /\brecall\s+(?:\w+\s+)?(?:the\s+)?dreams?\b/i,
      /\bhad\s+a\s+dream\b/i,
      /\bdreams?\s+(?:about|from|last|this|yesterday|recent)\b/i,
      /\bdream(?:ed|ing)\s+about\b/i,
      /\bdream\s+diary\b/i,
      /\bdream\s+(?:journal|log|record|recall|memory|memories)\b/i,
    ],
  },
];

/** Phrases that contain "dream" but are idiomatic (not memory-recall intent). */
const DREAM_FALSE_POSITIVE_PATTERNS: RegExp[] = [
  /\bpipe\s+dreams?\b/gi,
  /\bdream\s+team\b/gi,
  /\bamerican\s+dream\b/gi,
  /\bdream\s+(?:house|home|car|wedding|vacation|job|school)\b/gi,
  /\bin\s+(?:my|our|your)\s+dreams\b/gi,
];

const DREAM_MATCHED_PATTERNS = ["dream"] as const;

export interface DreamQuerySignal {
  active: boolean;
  matchedPatterns: readonly string[];
}

export function detectDreamQuerySignal(queryText: string): DreamQuerySignal {
  const candidateText = DREAM_FALSE_POSITIVE_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, " "),
    queryText,
  );

  for (const rule of DREAM_PATTERN_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(candidateText))) {
      return {
        active: true,
        matchedPatterns: [...DREAM_MATCHED_PATTERNS],
      };
    }
  }
  return {
    active: false,
    matchedPatterns: [],
  };
}

export function resolveDreamCollection(userId: string): string {
  const namespace = validateNamespace(userId.trim());
  return validateNamespace(`${DREAM_COLLECTION_PREFIX}${namespace}`);
}
