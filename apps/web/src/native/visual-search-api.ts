import {
  type VisualSearchCoverage,
  VisualSearchCoverageSchema,
  type VisualSearchInputResponse,
  VisualSearchInputResponseSchema,
  type VisualSearchMatch,
  type VisualSearchRequest,
  type VisualSearchResult,
  VisualSearchResultSchema,
} from '@kept/shared';
import type { z } from 'zod';
import { inventoryPaths, qs } from '@/api/inventory/paths';
import type { FileUrl } from '@/api/inventory/types';
import { visualSearchPaths } from '@/api/visual-search/paths';
import type { PlatformTransport } from './adapters';
import { type Connection, native, networkError, unwrap } from './bridge';

export const NATIVE_VISUAL_SOURCE_MAX_BYTES = 24 * 1024 * 1024;

export class VisualSearchProtocolError extends Error {
  constructor() {
    super('Incompatible visual search response');
    this.name = 'VisualSearchProtocolError';
  }
}

export type VisualSearchAdapter = {
  status(connection: Connection, locationId?: string): Promise<VisualSearchCoverage>;
  upload(
    connection: Connection,
    image: File,
    locationId?: string,
  ): Promise<VisualSearchInputResponse>;
  search(connection: Connection, body: VisualSearchRequest): Promise<VisualSearchResult>;
  cancel(connection: Connection, inputId: string): Promise<void>;
  thumbnail(connection: Connection, match: VisualSearchMatch): Promise<string>;
};

async function decode<T>(schema: z.ZodType<T>, response: Promise<unknown>): Promise<T> {
  try {
    const parsed = schema.safeParse(await response);
    if (!parsed.success) throw new VisualSearchProtocolError();
    return parsed.data;
  } catch (error) {
    if (error instanceof SyntaxError) throw new VisualSearchProtocolError();
    throw error;
  }
}

function imageBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const data = typeof reader.result === 'string' ? reader.result : '';
      const start = data.indexOf('base64,');
      if (start < 0) reject(new Error('Photo could not be read'));
      else resolve(data.slice(start + 'base64,'.length));
    };
    reader.readAsDataURL(file);
  });
}

function scope(locationId: string | undefined) {
  return qs({ locationIds: locationId });
}

export function nativeVisualSearch(request: PlatformTransport['request']): VisualSearchAdapter {
  return {
    status: (connection, locationId) =>
      decode(
        VisualSearchCoverageSchema,
        request(connection, visualSearchPaths.status + scope(locationId)),
      ),
    async upload(connection, image, locationId) {
      const response = await native
        .uploadVisualQuery({
          context: connection.id,
          image: await imageBase64(image),
          ...(locationId ? { locationIds: locationId } : {}),
        })
        .catch(networkError);
      return decode(VisualSearchInputResponseSchema, unwrap(response));
    },
    search: (connection, body) =>
      decode(
        VisualSearchResultSchema,
        request(connection, visualSearchPaths.search, { method: 'POST', body }),
      ),
    cancel: (connection, inputId) =>
      request(connection, visualSearchPaths.inputById(inputId), { method: 'DELETE' }),
    async thumbnail(connection, match) {
      const { url } = await request<FileUrl>(
        connection,
        inventoryPaths.fileUrl(match.fileId) + qs({ thingId: match.thingId }),
        { method: 'POST', body: { variant: 'thumb' } },
      );
      return url;
    },
  };
}
