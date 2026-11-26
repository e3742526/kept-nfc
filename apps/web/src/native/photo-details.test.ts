import { describe, expect, it } from 'vitest';
import { parseChatGPTDetails, pickDetailsModel } from './photo-details';

describe('parseChatGPTDetails', () => {
  it('reads the known fields, each a plain value with a confidence, from JSON in a code fence', () => {
    const text = [
      '```json',
      JSON.stringify({
        name: { value: ' DeWalt impact driver ', confidence: 0.92 },
        model: { value: 'DCF887', confidence: 1.4 },
        serial: 'SN-77',
        barcode: { value: '0885 9114 5367', confidence: 0.7 },
        colour: { value: 'unknown', confidence: 0.9 },
        type_hint: { value: 'power tool', confidence: 0.8 },
        specs: { value: '20 V, brushless', confidence: -1 },
        owner: { value: 'Ignored', confidence: 1 },
      }),
      '```',
    ].join('\n');
    expect(parseChatGPTDetails(text)).toEqual({
      details: {
        name: { value: 'DeWalt impact driver', confidence: 0.92 },
        model: { value: 'DCF887', confidence: 1 },
        serial: { value: 'SN-77', confidence: 0.5 },
        barcode: { value: '088591145367', confidence: 0.7 },
        specs: { value: '20 V, brushless', confidence: 0 },
      },
      typeHint: { value: 'power tool', confidence: 0.8 },
    });
  });

  it('drops a barcode that is not 8 to 14 digits and a value too long for its field', () => {
    const text = JSON.stringify({
      barcode: { value: 'ABC123', confidence: 0.9 },
      colour: { value: 'x'.repeat(61), confidence: 0.9 },
    });
    expect(parseChatGPTDetails(text)).toEqual({ details: {} });
  });

  it('refuses an answer with no JSON object', () => {
    expect(() => parseChatGPTDetails('I could not read the label.')).toThrow();
  });
});

describe('pickDetailsModel', () => {
  const models = [
    { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol' },
    { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' },
  ];
  it('keeps the remembered model, else Terra, else the first', () => {
    expect(pickDetailsModel(models, 'gpt-6.2-sol')).toBe('gpt-6.2-sol');
    expect(pickDetailsModel(models, 'retired-model')).toBe('gpt-6.1-terra');
    expect(pickDetailsModel([models[0] as (typeof models)[number]])).toBe('gpt-6.2-sol');
    expect(pickDetailsModel([])).toBe('');
  });
});
