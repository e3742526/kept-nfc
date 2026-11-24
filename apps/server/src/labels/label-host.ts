import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { notFound } from '../http/errors.js';

// Labels' own address (KEPT_LABEL_URL). A printed label and an NFC tag carry
// `<label address>/l/<code or alias>` for good, so the address on them must outlive the server
// behind it. The label address is a name pointed at this server; on it:
// - `GET|HEAD /l/<code>` (and `/t/<alias>`, a numbered label's other spelling) is sent on to
//   `KEPT_PUBLIC_URL/l/<code>` with a 302: the person signs in there, where their session is, and
//   the app frame brings them back to the label (web routes/_app/l.$code.tsx). 302, not 301, so a
//   browser never caches where the server was;
// - `/.well-known/apple-app-site-association` is served (below), with no redirect, as Apple
//   requires, so the iPhone app opens label links itself where it is installed;
// - `/` goes to the public address; anything else is a 404. Nothing else is served there: no
//   page, no sign-in, no API.
// The path segment is passed on only when it is a label's characters (letters, digits, hyphens,
// at most 32), so the redirect can never be steered anywhere but the public address's `/l/`.
//
// When KEPT_LABEL_URL is unset or the same host as the public URL, the hook does nothing.

const LABEL_SEGMENT = /^\/(l|t)\/([A-Za-z0-9-]{1,32})\/?$/;
export const APPLE_ASSOCIATION_PATH = '/.well-known/apple-app-site-association';

/** The request's host name, without the port, lower-cased. */
function hostOf(req: FastifyRequest): string | null {
  const raw = req.headers.host;
  if (!raw) return null;
  try {
    return new URL(`http://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The onRequest hook, or null when there is no separate label address. */
export function labelHostHook(
  labelUrl: string | undefined,
  publicUrl: string,
): onRequestAsyncHookHandler | null {
  if (!labelUrl) return null;
  const labelHost = new URL(labelUrl).hostname.toLowerCase();
  const publicBase = publicUrl.replace(/\/+$/, '');
  if (labelHost === new URL(publicUrl).hostname.toLowerCase()) return null;
  return async function labelAddress(req: FastifyRequest, reply: FastifyReply) {
    if (req.ingress || hostOf(req) !== labelHost) return;
    const path = req.url.split('?')[0] ?? '';
    if (path === APPLE_ASSOCIATION_PATH) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') throw notFound();
    if (path === '/' || path === '') return reply.redirect(`${publicBase}/`, 302);
    const m = LABEL_SEGMENT.exec(path);
    // `/t/` on the label address is only ever a numbered label: the public address's `/l/`
    // answers it (and `/t/` there is a thing's page).
    if (m) return reply.redirect(`${publicBase}/l/${m[2]}`, 302);
    throw notFound();
  };
}

/**
 * The Apple App Site Association file (apps/ios: Associated Domains `applinks:<label host>`):
 * label links open the iPhone app where it is installed. Only `/l/*` and `/t/*`; on the public
 * address `/t/` is a thing's page, which the app opens no differently from the browser. Null
 * when no app is configured (the route answers 404).
 */
export function appleAssociation(appIds: readonly string[]): object | null {
  if (appIds.length === 0) return null;
  return {
    applinks: {
      details: [
        {
          appIDs: [...appIds],
          components: [
            { '/': '/l/*', comment: 'A label: its code or numbered alias.' },
            { '/': '/t/???-????-????', comment: 'A numbered label read as /t/.' },
          ],
        },
      ],
    },
  };
}
