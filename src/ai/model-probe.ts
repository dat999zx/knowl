import type { VectorPooling } from '../core/vector-profile.js';

export type ProbeResult =
  | { ok: true; pooling: VectorPooling | null }
  | { ok: false; reason: string };

export type ProbeDeps = {
  fetchJson?: (url: string) => Promise<any>;
  fetchText?: (url: string) => Promise<string | null>;
};

const defaultFetchJson = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const defaultFetchText = async (url: string) => {
  const response = await fetch(url);
  return response.ok ? response.text() : null;
};

/**
 * Check a custom model before it reaches config.
 *
 * Pooling is returned as null rather than guessed when the model repo has no
 * 1_Pooling/config.json, which is common on ONNX mirrors. A wrong pooling value
 * produces plausible-looking vectors that rank badly with no error, so the caller
 * must ask rather than default.
 */
export async function verifyCustomModel(model: string, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const fetchText = deps.fetchText ?? defaultFetchText;

  let info: any;
  try {
    info = await fetchJson(`https://huggingface.co/api/models/${model}`);
  } catch {
    return { ok: false, reason: `Model "${model}" could not be found on Hugging Face.` };
  }

  const files: string[] = (info?.siblings ?? []).map((sibling: any) => String(sibling.rfilename));
  if (!files.includes('onnx/model_quantized.onnx')) {
    return {
      ok: false,
      reason: `Model "${model}" has no onnx/model_quantized.onnx, so it cannot run locally at q8. Look for an ONNX conversion of it.`,
    };
  }

  const poolingRaw = await fetchText(`https://huggingface.co/${model}/raw/main/1_Pooling/config.json`);
  if (!poolingRaw) return { ok: true, pooling: null };

  try {
    const pooling = JSON.parse(poolingRaw);
    if (pooling.pooling_mode_cls_token) return { ok: true, pooling: 'cls' };
    if (pooling.pooling_mode_mean_tokens) return { ok: true, pooling: 'mean' };
  } catch {
    // Unparseable is the same as absent: ask rather than assume.
  }
  return { ok: true, pooling: null };
}
