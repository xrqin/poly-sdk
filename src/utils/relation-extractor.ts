/**
 * LLM-based market relation extractor.
 *
 * Analyzes market questions to identify logical implications (A ⇒ B).
 * Used for cross-market arbitrage detection.
 */

import type { GammaMarket } from '../clients/gamma-api.js';

// ===== Types =====

export type RelationType = 'A_IMPLIES_B' | 'B_IMPLIES_A' | 'EQUIVALENT';
export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface MarketRef {
  conditionId: string;
  question: string;
  slug?: string;
}

export interface ImplicationCandidate {
  marketA: MarketRef;
  marketB: MarketRef;
  relation: RelationType;
  confidence: ConfidenceLevel;
  reasoning: string;
}

export interface LLMConfig {
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model?: string;
}

interface LLMResponse {
  implications: Array<{
    indexA: number;
    indexB: number;
    relation: RelationType;
    confidence: ConfidenceLevel;
    reasoning: string;
  }>;
}

// ===== Prompt Template =====

const SYSTEM_PROMPT = `You are an expert at analyzing prediction market questions to identify logical implications.

Given a list of market questions, identify pairs where one outcome LOGICALLY IMPLIES the other.

Types of implications to find:
1. A_IMPLIES_B: If A happens, B must also happen (A → B)
   Example: "Trump wins Republican primary" → "Trump is Republican nominee"
   
2. B_IMPLIES_A: If B happens, A must also happen (B → A)
   Same as above but reversed relationship
   
3. EQUIVALENT: A and B are essentially the same question (A ↔ B)
   Example: "BTC reaches $100k" ≈ "Bitcoin hits $100,000"

Rules:
- Only identify STRONG logical implications, not correlations
- The implication must hold with near certainty
- Focus on definitional/causal relationships
- Ignore timing differences if the logic holds

Confidence levels:
- HIGH: Near-certain logical relationship (definitional)
- MEDIUM: Very likely but with edge cases
- LOW: Probable but uncertain

Output JSON format:
{
  "implications": [
    {
      "indexA": 0,
      "indexB": 3,
      "relation": "A_IMPLIES_B",
      "confidence": "HIGH",
      "reasoning": "If X happens, Y must follow because..."
    }
  ]
}

If no implications found, return: {"implications": []}`;

function buildUserPrompt(markets: MarketRef[]): string {
  const marketList = markets
    .map((m, i) => `[${i}] ${m.question}`)
    .join('\n');

  return `Analyze these ${markets.length} prediction market questions for logical implications:

${marketList}

Return JSON with any implications found. Focus on HIGH and MEDIUM confidence only.`;
}

// ===== LLM Clients =====

async function callOpenAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<LLMResponse> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error('Empty response from OpenAI');
  }

  return JSON.parse(content) as LLMResponse;
}

async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string
): Promise<LLMResponse> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  const content = data.content?.[0]?.text;

  if (!content) {
    throw new Error('Empty response from Anthropic');
  }

  // Extract JSON from response (Claude might wrap it in text)
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON found in Anthropic response');
  }

  return JSON.parse(jsonMatch[0]) as LLMResponse;
}

// ===== Main Functions =====

/**
 * Extract implication relationships from a list of markets using LLM.
 *
 * @param markets - List of markets to analyze
 * @param config - LLM configuration
 * @param options - Additional options
 * @returns List of implication candidates
 */
export async function extractImplications(
  markets: GammaMarket[],
  config: LLMConfig,
  options: {
    batchSize?: number;
    minConfidence?: ConfidenceLevel;
  } = {}
): Promise<ImplicationCandidate[]> {
  const { batchSize = 50, minConfidence = 'MEDIUM' } = options;

  // Convert to MarketRef for LLM
  const marketRefs: MarketRef[] = markets.map((m) => ({
    conditionId: m.conditionId,
    question: m.question,
    slug: m.slug,
  }));

  const allCandidates: ImplicationCandidate[] = [];

  // Process in batches to avoid token limits
  for (let i = 0; i < marketRefs.length; i += batchSize) {
    const batch = marketRefs.slice(i, i + batchSize);

    if (batch.length < 2) continue;

    const userPrompt = buildUserPrompt(batch);

    let response: LLMResponse;

    if (config.provider === 'openai') {
      response = await callOpenAI(
        config.apiKey,
        config.model || 'gpt-4o-mini',
        SYSTEM_PROMPT,
        userPrompt
      );
    } else if (config.provider === 'anthropic') {
      response = await callAnthropic(
        config.apiKey,
        config.model || 'claude-3-haiku-20240307',
        SYSTEM_PROMPT,
        userPrompt
      );
    } else {
      throw new Error(`Unsupported LLM provider: ${config.provider}`);
    }

    // Convert response to candidates
    for (const imp of response.implications || []) {
      // Filter by confidence
      if (minConfidence === 'HIGH' && imp.confidence !== 'HIGH') continue;
      if (minConfidence === 'MEDIUM' && imp.confidence === 'LOW') continue;

      const marketA = batch[imp.indexA];
      const marketB = batch[imp.indexB];

      if (!marketA || !marketB) continue;

      allCandidates.push({
        marketA,
        marketB,
        relation: imp.relation,
        confidence: imp.confidence,
        reasoning: imp.reasoning,
      });
    }
  }

  return allCandidates;
}

/**
 * Get LLM config from environment variables.
 */
export function getLLMConfigFromEnv(): LLMConfig | null {
  const provider = (process.env.LLM_PROVIDER || 'openai') as 'openai' | 'anthropic';

  let apiKey: string | undefined;
  if (provider === 'openai') {
    apiKey = process.env.OPENAI_API_KEY;
  } else if (provider === 'anthropic') {
    apiKey = process.env.ANTHROPIC_API_KEY;
  }

  if (!apiKey) {
    return null;
  }

  return {
    provider,
    apiKey,
    model: process.env.LLM_MODEL,
  };
}

/**
 * Simple deduplication of implication candidates.
 */
export function deduplicateCandidates(
  candidates: ImplicationCandidate[]
): ImplicationCandidate[] {
  const seen = new Set<string>();
  const result: ImplicationCandidate[] = [];

  for (const c of candidates) {
    // Create a canonical key (order-independent for EQUIVALENT)
    let key: string;
    if (c.relation === 'EQUIVALENT') {
      const ids = [c.marketA.conditionId, c.marketB.conditionId].sort();
      key = `${ids[0]}:${ids[1]}:EQUIVALENT`;
    } else {
      key = `${c.marketA.conditionId}:${c.marketB.conditionId}:${c.relation}`;
    }

    if (!seen.has(key)) {
      seen.add(key);
      result.push(c);
    }
  }

  return result;
}

