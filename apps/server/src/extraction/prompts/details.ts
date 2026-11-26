/**
 * THING read for its details (photo-details.ts): a person editing a thing asks what its photos
 * say. The photos are one object seen several ways (the object, its nameplate, the box), and the
 * answer only fills the edit form for the person to review; nothing is applied. Unlike LABEL it
 * may name the model's specifications from what is known about that exact model code, which the
 * person asked for and checks before saving.
 */
import { type BuiltPrompt, languageList, type PromptContext, systemPrompt } from './common.js';

export const PROMPT_VERSION = 'details-v1';

export function detailsPrompt(ctx: PromptContext & { photos: number }): BuiltPrompt {
  const first = ctx.languages[0] ?? 'en';
  const several = ctx.photos > 1;
  return {
    version: PROMPT_VERSION,
    system: systemPrompt('read the details of one item from its photos', [
      several
        ? `The ${ctx.photos} photos all show the same item: the item itself, a label or nameplate on it, or its box or manual. Combine what they show into one entry.`
        : 'The photo shows one item, a label or nameplate on it, or its box or manual.',
      'objects: exactly one entry, for that item.',
      `name: a short everyday name a person would search for, in ${languageList([first])}, with the brand first when it is known, such as "DeWalt impact driver".`,
      'brand: the maker as printed or unmistakable from the design.',
      'model: the model name or model code, copied exactly as printed (keep letters, digits, dashes and slashes). Prefer the code on a nameplate or rating label.',
      'serial: only a number labelled as a serial number (S/N, Serial, SN); copy it exactly.',
      'barcode: only the digits printed under a UPC or EAN barcode, without spaces.',
      'colour: the main colour in one or two plain words.',
      'type_hint: a general kind in English, such as "power tool", "cable", "phone" or "kitchen appliance".',
      `specs: the item's key specifications in one short line, in ${languageList([first])}, such as "20 V, brushless, 1/4 in hex chuck, 3 speeds". Use what is printed; you may add what you reliably know about that exact model code, with a lower confidence. Leave it out when the model is not known.`,
    ]),
    text: 'What are the details of this item?',
  };
}
