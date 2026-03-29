import type { SearchResult } from "./types.js";

interface HybridOptions {
  alpha?: number;
  beta?: number;
  gamma?: number;
  delta?: number;
  recencyLambdaSession?: number;
  recencyLambdaUser?: number;
  recencyLambdaGlobal?: number;
  sessionId: string;
  userId: string;
}

export function scoreCandidates(items: SearchResult[], opts: HybridOptions): SearchResult[] {
  const now = Date.now();
  const alpha = opts.alpha ?? 0.7;
  const beta = opts.beta ?? 0.2;
  const gamma = opts.gamma ?? 0.1;
  const delta = opts.delta ?? 0.5;
  const recencyLambdaSession = opts.recencyLambdaSession ?? 0.0001;
  const recencyLambdaUser = opts.recencyLambdaUser ?? 0.00001;
  const recencyLambdaGlobal = opts.recencyLambdaGlobal ?? 0.000002;

  return items
    .map((item) => {
      const ts = typeof item.metadata.ts === "number" ? item.metadata.ts : now;
      const lambda =
        item.metadata.sessionId === opts.sessionId ? recencyLambdaSession
          : item.metadata.userId === opts.userId ? recencyLambdaUser
            : recencyLambdaGlobal;
      const recency = Math.exp(-lambda * Math.max(0, now - ts));
      const scopeBoost =
        item.metadata.sessionId === opts.sessionId ? 1.0
          : item.metadata.userId === opts.userId ? 0.6
            : 0.3;
      const baseScore =
        alpha * item.score +
        beta * recency +
        gamma * scopeBoost;
      const rawDecayRate =
        typeof item.metadata.decay_rate === "number" ? item.metadata.decay_rate : 0.0;
      const decayRate = Math.min(1, Math.max(0, rawDecayRate));
      const quality =
        item.metadata.type === "summary"
          ? 1.0 - delta * decayRate
          : 1.0;
      const finalScore = baseScore * quality;

      return {
        ...item,
        finalScore,
      };
    })
    .sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
}
