const DREAM_COLLECTION_PREFIX = "dream:";

const DREAM_PATTERN_RULES: Array<{ label: string; patterns: RegExp[] }> = [
  {
    label: "dream",
    patterns: [
      /\bdream(?:s|ed|ing)?\b/i,
      /\btell\s+me\s+about\s+(?:your\s+)?dreams?\b/i,
      /\bwhat\s+did\s+i\s+dream\s+about\b/i,
      /\bwhat\s+was\s+i\s+dreaming\s+about\b/i,
    ],
  },
];

const DREAM_MATCHED_PATTERNS: string[] = ["dream"];
const EMPTY_MATCHED_PATTERNS: string[] = [];

export interface DreamQuerySignal {
  active: boolean;
  matchedPatterns: string[];
}

export function detectDreamQuerySignal(queryText: string): DreamQuerySignal {
  for (const rule of DREAM_PATTERN_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(queryText))) {
      return {
        active: true,
        matchedPatterns: DREAM_MATCHED_PATTERNS,
      };
    }
  }
  return {
    active: false,
    matchedPatterns: EMPTY_MATCHED_PATTERNS,
  };
}

export function resolveDreamCollection(userId: string): string {
  return `${DREAM_COLLECTION_PREFIX}${userId.trim()}`;
}
