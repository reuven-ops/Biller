// Local inference: open-source embedding model and cross-encoder reranker running in
// process on CPU via Transformers.js. Model files live under MODELS_DIR (baked into
// the Docker images at build time; brief non-negotiable 8) and no network call happens
// at answer time. Model choice and dimension: docs/DECISIONS.md D12.
import {
  env,
  pipeline,
  AutoTokenizer,
  AutoModelForSequenceClassification,
} from '@huggingface/transformers';
import { optionalEnv } from '@advisor/db';

export const EMBEDDING_MODEL_ID = 'Xenova/bge-base-en-v1.5';
export const RERANK_MODEL_ID = 'Xenova/bge-reranker-base';
export const EMBEDDING_DIM = 768;

// BGE recommends this prefix for retrieval queries (not for passages).
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

let configured = false;
function configure(): void {
  if (configured) return;
  env.cacheDir = optionalEnv('MODELS_DIR', './models');
  env.allowRemoteModels = optionalEnv('MODELS_ALLOW_DOWNLOAD', '1') === '1';
  configured = true;
}

type FeatureExtractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist: () => number[][] }>;

let embedderPromise: Promise<FeatureExtractor> | undefined;

async function getEmbedder(): Promise<FeatureExtractor> {
  configure();
  embedderPromise ??= pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
    dtype: 'fp32',
  }) as unknown as Promise<FeatureExtractor>;
  return embedderPromise;
}

/** Embeds passages (document chunks). Normalized 768-d vectors. */
export async function embedPassages(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const embedder = await getEmbedder();
  const out = await embedder(texts, { pooling: 'mean', normalize: true });
  return out.tolist();
}

/** Embeds a retrieval query with the BGE query prefix. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embedPassages([QUERY_PREFIX + text]);
  return vec!;
}

interface RerankerParts {
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;
}

let rerankerPromise: Promise<RerankerParts> | undefined;

async function getReranker(): Promise<RerankerParts> {
  configure();
  rerankerPromise ??= (async () => {
    const tokenizer = await AutoTokenizer.from_pretrained(RERANK_MODEL_ID);
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL_ID, {
      dtype: 'fp32',
    });
    return { tokenizer, model };
  })();
  return rerankerPromise;
}

/** Cross-encoder relevance scores for (query, passage) pairs; higher is better. */
export async function rerankScores(query: string, passages: string[]): Promise<number[]> {
  if (passages.length === 0) return [];
  const { tokenizer, model } = await getReranker();
  const scores: number[] = [];
  const BATCH = 8;
  for (let i = 0; i < passages.length; i += BATCH) {
    const batch = passages.slice(i, i + BATCH);
    const inputs = tokenizer(new Array<string>(batch.length).fill(query), {
      text_pair: batch,
      padding: true,
      truncation: true,
    });
    const output = (await model(inputs)) as { logits: { tolist: () => number[][] } };
    for (const row of output.logits.tolist()) {
      scores.push(row[0]!);
    }
  }
  return scores;
}

/** pgvector text form. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.map((v) => v.toFixed(7)).join(',')}]`;
}
