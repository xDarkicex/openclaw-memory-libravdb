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
  /\bpipe\s+dreams?\b/i,
  /\bdream\s+team\b/i,
  /\bamerican\s+dream\b/i,
  /\bdream\s+(?:house|home|car|wedding|vacation|job|school)\b/i,
  /\bin\s+(?:my|our|your)\s+dreams\b/i,
];

const DREAM_MATCHED_PATTERNS = ["dream"] as const;

export interface DreamQuerySignal {
  active: boolean;
  matchedPatterns: readonly string[];
}

export function detectDreamQuerySignal(queryText: string): DreamQuerySignal {
  for (const rule of DREAM_PATTERN_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(queryText))) {
      // Reject known idiomatic false positives that slip through.
      if (DREAM_FALSE_POSITIVE_PATTERNS.some((p) => p.test(queryText))) {
        return {
          active: false,
          matchedPatterns: [],
        };
      }
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
  return `${DREAM_COLLECTION_PREFIX}${userId.trim()}`;
}
