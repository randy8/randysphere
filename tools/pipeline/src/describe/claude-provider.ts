import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import { PipelineError } from '../errors.ts';
import type { Description, DescriptionProvider, DescriptionRequest } from './provider.ts';

/**
 * Never `claude-opus-5` by convention alone — it's the default because no
 * model was named. Pass a different one to `createClaudeDescriptionProvider`
 * to override it; nothing here should stop that.
 */
export const DEFAULT_MODEL = 'claude-opus-5';

const MEDIA_TYPE: Record<string, 'image/jpeg' | 'image/png' | 'image/webp'> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const DESCRIPTION_SCHEMA = {
  type: 'object',
  properties: {
    alt: {
      type: 'string',
      description:
        'One objective sentence for a screen reader: visible subjects, setting, composition.',
    },
    caption: {
      type: 'string',
      description: 'A short one-sentence caption suitable to show under the photograph.',
    },
  },
  required: ['alt', 'caption'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `
You write accessible alt text and a short caption for a single photograph in a
personal photography portfolio.

Describe only what is visibly in the image: subjects, setting, atmosphere,
composition, and notable details. Do not invent or guess anything you cannot
verify from the pixels themselves — not an exact place name or landmark, not a
person's identity, not a specific date or event, not camera, lens, or film
stock. If a sign, label, or landmark is clearly legible in the frame, you may
mention it; otherwise stay general ("a narrow street", "a train platform").

You will be given soft contextual hints (an album name and a roll id derived
from folder names). Treat them only as loose orientation for tone, never as
verified fact to assert — a folder named after a city means the photographer
grouped photos that way, not that this specific frame shows a confirmed
landmark in that city.

Respond with nothing but a single JSON object matching this schema — no
markdown code fences, no text before or after it:
${JSON.stringify(DESCRIPTION_SCHEMA)}
`.trim();

/** Strips a markdown code fence if the model wrapped the JSON in one anyway. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

function buildUserText(context: DescriptionRequest['context']): string {
  return (
    `Soft context, not verified fact: this photograph is filed under the album "${context.album}", ` +
    `roll "${context.roll}". Describe only what you can see.`
  );
}

export interface ClaudeProviderOptions {
  readonly model?: string;
  readonly client?: Anthropic;
}

export function createClaudeDescriptionProvider(
  options: ClaudeProviderOptions = {},
): DescriptionProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const client = options.client ?? new Anthropic();

  return {
    name: 'claude',
    async describe(request: DescriptionRequest): Promise<Description> {
      const mediaType = MEDIA_TYPE[extname(request.imagePath).toLowerCase()];
      if (mediaType === undefined) {
        throw new PipelineError(
          `${request.imagePath}: not a format this provider can send as an image (need jpg/png/webp).`,
        );
      }
      const data = (await readFile(request.imagePath)).toString('base64');

      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
              { type: 'text', text: buildUserText(request.context) },
            ],
          },
        ],
      });

      if (response.stop_reason === 'refusal') {
        throw new PipelineError(`${request.imagePath}: the model declined to describe this image.`);
      }

      const block = response.content.find((entry) => entry.type === 'text');
      if (block === undefined) {
        throw new PipelineError(`${request.imagePath}: the model returned no text content.`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripCodeFence(block.text));
      } catch (cause) {
        throw new PipelineError(`${request.imagePath}: the model's response was not valid JSON.`, {
          cause,
        });
      }
      const record = parsed as Partial<Description>;
      if (typeof record.alt !== 'string' || record.alt.length === 0) {
        throw new PipelineError(
          `${request.imagePath}: the model's response had no usable "alt" text.`,
        );
      }
      if (typeof record.caption !== 'string' || record.caption.length === 0) {
        throw new PipelineError(
          `${request.imagePath}: the model's response had no usable "caption" text.`,
        );
      }
      return { alt: record.alt, caption: record.caption };
    },
  };
}
