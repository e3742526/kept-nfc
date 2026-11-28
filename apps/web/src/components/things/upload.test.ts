import { afterEach, expect, it, vi } from 'vitest';
import { xhrPut } from './upload';

afterEach(() => vi.unstubAllGlobals());

it.each(['', '<html>Sign in</html>'])(
  'rejects a successful upload with unreadable JSON (%j)',
  async (body) => {
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        upload = {};
        status = 200;
        responseText = body;
        onload?: () => void;
        open() {}
        send() {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    await expect(xhrPut('/upload', new Blob(), {}, () => {})).rejects.toMatchObject({
      status: 502,
      code: 'internal',
    });
  },
);
