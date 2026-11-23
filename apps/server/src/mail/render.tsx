import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CHROME, type Chrome, type MailLocale, type Message } from './messages.js';

// A mail's two parts (D81: templates rendered from React). The HTML is one small React tree
// rendered to static markup, which escapes every name a person chose (a location, an inviter),
// so none of it can become markup in someone's inbox. Inline styles only: mail clients ignore
// most stylesheets; the one <style> block only repaints the page for dark mode. The plain-text
// part carries the same words, and the link spelled out.
//
// Mail uses a text wordmark so the header renders without externally loaded images or fonts.
export type RenderedMail = { subject: string; text: string; html: string };

/** SheepKeep's colours, from the web app's tokens (apps/web/src/styles/tokens.css). The tape and its
 * ink keep their colours in both themes; the rest has a dark counterpart. */
export const BRAND = {
  amber: '#E2B86B',
  amberInk: '#2E2100',
  light: {
    paper: '#FFF9EB',
    surface: '#FFFCF3',
    line: '#DEDBD3',
    ink: '#173E37',
    ink2: '#55524C',
    ink3: '#6B675F',
  },
  dark: {
    paper: '#173E37',
    surface: '#214942',
    line: '#34302A',
    ink: '#FFF9EB',
    ink2: '#BDB7AC',
    ink3: '#B9C9BC',
  },
} as const;

/** Where the project lives: the one address in a mail that isn't the instance's own. */
export const PROJECT_SITE = 'https://github.com/e3742526/kept-nfc';

const FONT =
  "-apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans Arabic', Arial, sans-serif";

const L = BRAND.light;
const D = BRAND.dark;

/** Clients that honour prefers-color-scheme (Apple Mail, Outlook for Mac, iOS) repaint by class;
 * the rest show the light colours, or invert them, which the tape survives. */
const STYLE =
  ':root{color-scheme:light dark;supported-color-schemes:light dark}' +
  '@media (prefers-color-scheme: dark){' +
  `.k-page{background-color:${D.paper}!important}` +
  `.k-card{background-color:${D.surface}!important;border-color:${D.line}!important}` +
  `.k-ink{color:${D.ink}!important}` +
  `.k-ink2{color:${D.ink2}!important}` +
  `.k-ink3{color:${D.ink3}!important}` +
  '}';

/** A presentation table's fixed attributes. */
const TABLE = { role: 'presentation', cellPadding: 0, cellSpacing: 0, border: 0 } as const;

function Lockup() {
  return (
    <strong
      className="k-ink"
      dir="ltr"
      data-kept-mark=""
      style={{ color: L.ink, fontSize: '22px' }}
    >
      SheepKeep
    </strong>
  );
}

/** `line` with its first `part` as a link to `href`. */
function linked(line: string, part: string, href: string): ReactNode {
  const at = line.indexOf(part);
  if (at < 0) return line;
  return (
    <>
      {line.slice(0, at)}
      <a
        href={href}
        dir="ltr"
        className="k-ink2"
        style={{ color: L.ink2, textDecoration: 'underline' }}
      >
        {part}
      </a>
      {line.slice(at + part.length)}
    </>
  );
}

function Mail({
  message,
  chrome,
  home,
  host,
}: {
  message: Message;
  chrome: Chrome;
  home: string;
  host: string;
}) {
  const align = chrome.dir === 'rtl' ? 'right' : 'left';
  const site = 'github.com/e3742526/kept-nfc';
  const text = { fontFamily: FONT, textAlign: align } as const;
  return (
    <table
      {...TABLE}
      dir={chrome.dir}
      width="100%"
      style={{ width: '100%', maxWidth: '560px', margin: '0 auto' }}
    >
      <tbody>
        <tr>
          <td style={{ ...text, padding: '0 4px 16px' }}>
            <Lockup />
          </td>
        </tr>
        <tr>
          <td
            className="k-card k-ink"
            style={{
              ...text,
              fontSize: '16px',
              lineHeight: '1.5',
              color: L.ink,
              backgroundColor: L.surface,
              border: `1px solid ${L.line}`,
              borderRadius: '8px',
              padding: '24px',
            }}
          >
            {message.paragraphs.map((p) => (
              <p key={p} className="k-ink" style={{ margin: '0 0 16px', color: L.ink }}>
                {p}
              </p>
            ))}
            {message.action ? (
              <>
                <table
                  {...TABLE}
                  data-kept-action=""
                  bgcolor={BRAND.amber}
                  style={{ margin: '24px 0', borderCollapse: 'separate', borderRadius: '6px' }}
                >
                  <tbody>
                    <tr>
                      <td style={{ backgroundColor: BRAND.amber, borderRadius: '6px' }}>
                        <a
                          href={message.action.url}
                          style={{
                            display: 'inline-block',
                            padding: '12px 20px',
                            fontFamily: FONT,
                            fontSize: '16px',
                            lineHeight: '20px',
                            fontWeight: 600,
                            color: BRAND.amberInk,
                            textDecoration: 'none',
                            borderRadius: '6px',
                          }}
                        >
                          {message.action.label}
                        </a>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p
                  className="k-ink2"
                  style={{ margin: '0 0 16px', fontSize: '13px', color: L.ink2 }}
                >
                  {chrome.linkFallback}
                  <br />
                  <span dir="ltr" style={{ wordBreak: 'break-all' }}>
                    {message.action.url}
                  </span>
                </p>
              </>
            ) : null}
            {message.footnote ? (
              <p className="k-ink2" style={{ margin: '16px 0 0', fontSize: '13px', color: L.ink2 }}>
                {message.footnote}
              </p>
            ) : null}
          </td>
        </tr>
        <tr>
          <td
            className="k-ink3"
            style={{
              ...text,
              padding: '16px 4px 0',
              fontSize: '13px',
              lineHeight: '1.5',
              color: L.ink3,
            }}
          >
            <p style={{ margin: 0 }}>{linked(chrome.sentBy(host), host, home)}</p>
            <p style={{ margin: '4px 0 0' }}>{linked(chrome.about(site), site, PROJECT_SITE)}</p>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

function text(message: Message, chrome: Chrome, host: string): string {
  const parts = [...message.paragraphs];
  if (message.action) parts.push(`${message.action.label}:\n${message.action.url}`);
  if (message.footnote) parts.push(message.footnote);
  parts.push(`-- \n${chrome.sentBy(host)}\n${chrome.about(PROJECT_SITE)}`);
  return `${parts.join('\n\n')}\n`;
}

/** The subject, text and HTML of a message, in its language's direction. */
export function renderMail(message: Message, locale: MailLocale, publicUrl: string): RenderedMail {
  const chrome = CHROME[locale];
  const home = new URL(publicUrl);
  const column = renderToStaticMarkup(
    <Mail message={message} chrome={chrome} home={home.href} host={home.host} />,
  );
  // The page, and the column centred in it. Outlook for Windows sizes the column by the
  // conditional 560 px table, since it ignores max-width.
  const page = `background-color:${L.paper}`;
  const html =
    `<!doctype html><html lang="${locale}" dir="${chrome.dir}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark">` +
    `<meta name="supported-color-schemes" content="light dark">` +
    `<style>${STYLE}</style></head>` +
    `<body class="k-page" style="margin:0;padding:0;${page}">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" dir="${chrome.dir}" class="k-page" bgcolor="${L.paper}" style="width:100%;${page}">` +
    `<tr><td align="center" style="padding:24px 16px">` +
    `<!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" align="center"><tr><td><![endif]-->` +
    column +
    `<!--[if mso]></td></tr></table><![endif]-->` +
    `</td></tr></table></body></html>`;
  return { subject: message.subject, text: text(message, chrome, home.host), html };
}
