import { describe, expect, it } from 'vitest';
import { verifyCustomModel } from '../../src/ai/model-probe.js';

const withFiles = (siblings: string[]) => async () => ({ siblings: siblings.map(rfilename => ({ rfilename })) });

describe('verifyCustomModel', () => {
  it('rejects a model that does not resolve', async () => {
    const result = await verifyCustomModel('nobody/nothing', {
      fetchJson: async () => { throw new Error('404'); },
      fetchText: async () => null,
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('could not be found') });
  });

  it('rejects a model with no q8 ONNX weights', async () => {
    const result = await verifyCustomModel('someone/pytorch-only', {
      fetchJson: withFiles(['pytorch_model.bin', 'config.json']),
      fetchText: async () => null,
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('onnx/model_quantized.onnx') });
  });

  it('reads cls pooling from 1_Pooling/config.json', async () => {
    const result = await verifyCustomModel('someone/good-ONNX', {
      fetchJson: withFiles(['onnx/model_quantized.onnx']),
      fetchText: async () => JSON.stringify({ pooling_mode_cls_token: true, pooling_mode_mean_tokens: false }),
    });
    expect(result).toEqual({ ok: true, pooling: 'cls' });
  });

  it('reads mean pooling from 1_Pooling/config.json', async () => {
    const result = await verifyCustomModel('someone/good-ONNX', {
      fetchJson: withFiles(['onnx/model_quantized.onnx']),
      fetchText: async () => JSON.stringify({ pooling_mode_cls_token: false, pooling_mode_mean_tokens: true }),
    });
    expect(result).toEqual({ ok: true, pooling: 'mean' });
  });

  it('returns null pooling when the file is absent, so the caller must ask', async () => {
    const result = await verifyCustomModel('someone/mirror-ONNX', {
      fetchJson: withFiles(['onnx/model_quantized.onnx']),
      fetchText: async () => null,
    });
    expect(result).toEqual({ ok: true, pooling: null });
  });
});
