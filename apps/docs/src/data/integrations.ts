/** The integrations shown on the documentation site. */
import type { IconName } from '../components/landing/icons';
import type { Lang } from '../i18n';

export interface Words {
  /** Short, for the landing page's chip. */
  name: string;
  /** The heading on the integrations page; `name` when it says enough. */
  title?: string;
  /** One or two fragments: what it does, from the user's side. */
  body: string;
}

export interface Integration {
  id: string;
  icon: IconName;
  href: string;
  code: string[];
  en: Words;
}

export interface IntegrationGroup {
  id: string;
  en: string;
  items: Integration[];
}

export const integrationGroups: IntegrationGroup[] = [
  {
    id: 'bring-in',
    en: 'Bring things in',

    items: [
      {
        id: 'csv',
        icon: 'table',
        href: '/users/import-export/#a-spreadsheet-csv',
        code: ['apps/server/src/imports/csv.ts', 'apps/server/src/imports/routes.ts'],
        en: {
          name: 'CSV',
          title: 'Spreadsheet (CSV) import',
          body: 'One thing per row. Map the columns, check, then import.',
        },
      },
      {
        id: 'homebox',
        icon: 'packageImport',
        href: '/users/import-export/#a-homebox-export',
        code: ['apps/server/src/imports/homebox/', 'apps/server/src/imports/archive.ts'],
        en: {
          name: 'Homebox',
          title: 'Homebox import',
          body: 'Its export ZIP, files included. Old Homebox labels still scan.',
        },
      },
      {
        id: 'lubelogger',
        icon: 'vehicle',
        href: '/users/import-export/#a-vehicles-lubelogger-history',
        code: ['apps/server/src/imports/lubelogger.ts'],
        en: {
          name: 'LubeLogger',
          title: 'LubeLogger import',
          body: "A vehicle's fuel, service and odometer history. One CSV at a time.",
        },
      },
      {
        id: 'kept-export',
        icon: 'fileImport',
        href: '/users/import-export/#a-kept-export',
        code: ['apps/server/src/imports/kept/'],
        en: {
          name: 'Another Kept',
          title: 'Import from another Kept',
          body: 'A location exported from one Kept, imported into another.',
        },
      },
      {
        id: 'barcodes',
        icon: 'barcode',
        href: '/users/everyday-use/#short-ids-and-labels',
        code: ['apps/server/src/scan/barcode.ts'],
        en: {
          name: 'Barcodes',
          title: 'Product barcode lookup',
          body: 'Named from Open Food Facts, Open Products Facts or Open Beauty Facts. Off until an admin turns it on.',
        },
      },
      {
        id: 'camera',
        icon: 'camera',
        href: '/users/phone-app/#camera-gallery-and-scanning',
        code: ['apps/server/src/capture/', 'apps/web/src/components/capture/'],
        en: {
          name: 'Camera',
          title: 'Camera capture',
          body: 'One photo per thing, straight into a room or box. Name it later.',
        },
      },
      {
        id: 'email-in',
        icon: 'mail',
        href: '/users/everyday-use/#photos-receipts-manuals-and-warranties',
        code: ['apps/server/src/mailin/'],
        en: {
          name: 'Email-in',
          title: 'Email-in (IMAP)',
          body: 'A mailbox folder you already have. Receipts that arrive become drafts.',
        },
      },
      {
        id: 'paperless',
        icon: 'paperwork',
        href: '/users/paperless/',
        code: ['apps/server/src/paperless/', 'apps/web/src/components/paperless/'],
        en: {
          name: 'Paperless-ngx',
          title: 'Paperless-ngx documents',
          body: 'Link a thing to its receipts and manuals in Paperless. Copy one in when you want it kept.',
        },
      },
      {
        id: 'reading',
        icon: 'paperwork',
        href: '/users/ai-providers/#what-uses-ai-and-what-it-costs',
        code: ['apps/server/src/extraction/'],
        en: {
          name: 'Receipt reading',
          title: 'Receipts and labels, read by AI',
          body: 'With AI on: the purchase, the brand, model and serial. You accept them.',
        },
      },
    ],
  },
  {
    id: 'get-told',
    en: 'Get told',

    items: [
      {
        id: 'email',
        icon: 'mail',
        href: '/admin/notifications/#mail',
        code: ['apps/server/src/notify/senders.ts', 'apps/server/src/mail/'],
        en: {
          name: 'Email',
          title: 'Email notifications (SMTP)',
          body: 'Reminders and a daily digest. Over your own SMTP server.',
        },
      },
      {
        id: 'web-push',
        icon: 'bell',
        href: '/admin/notifications/#web-push',
        code: ['apps/server/src/notify/push.ts', 'apps/server/src/notify/vapid.ts'],
        en: {
          name: 'Web push',
          title: 'Web push notifications',
          body: 'On the phone and the desktop. No keys to set up.',
        },
      },
      {
        id: 'ntfy',
        icon: 'message',
        href: '/admin/notifications/#ntfy-and-telegram',
        code: ['apps/server/src/notify/relay.ts'],
        en: {
          name: 'ntfy',
          title: 'ntfy notifications',
          body: 'ntfy.sh or your own server, on a topic you choose.',
        },
      },
      {
        id: 'telegram',
        icon: 'send',
        href: '/admin/notifications/#ntfy-and-telegram',
        code: ['apps/server/src/notify/relay.ts'],
        en: {
          name: 'Telegram',
          title: 'Telegram notifications',
          body: 'Your own bot, to your chat.',
        },
      },
      {
        id: 'apprise',
        icon: 'speakerphone',
        href: '/admin/notifications/#apprise',
        code: ['apps/server/src/notify/senders.ts', 'apps/server/src/notify/channels.ts'],
        en: {
          name: 'Apprise',
          title: 'Apprise: Discord, Slack, Matrix, Signal',
          body: 'Discord, Slack, Matrix, Signal and more. Through an Apprise server you run.',
        },
      },
      {
        id: 'calendar',
        icon: 'calendar',
        href: '/admin/notifications/#the-calendar-feed',
        code: ['apps/server/src/calendar/'],
        en: {
          name: 'Calendar feed',
          title: 'Calendar feed (iCal)',
          body: "A private iCal link. What's due, what runs out.",
        },
      },
    ],
  },
  {
    id: 'sign-in',
    en: 'Sign in',

    items: [
      {
        id: 'passkeys',
        icon: 'fingerprint',
        href: '/admin/security-model/#signing-in',
        code: ['apps/server/src/auth/auth.ts'],
        en: { name: 'Passkeys', body: 'The phone or laptop you already unlock.' },
      },
      {
        id: 'two-factor',
        icon: 'shieldLock',
        href: '/admin/security-model/#signing-in',
        code: ['apps/server/src/auth/auth.ts'],
        en: {
          name: 'Two-factor',
          title: 'Two-factor authentication',
          body: 'An authenticator app or a passkey. A location can require it.',
        },
      },
      {
        id: 'oidc',
        icon: 'login',
        href: '/admin/security-model/#signing-in',
        code: ['apps/server/src/auth/oidc.ts'],
        en: {
          name: 'OIDC',
          title: 'OIDC single sign-on',
          body: 'Your own identity provider. New people still need an invite or an allowed domain.',
        },
      },
      {
        id: 'google',
        icon: 'login',
        href: '/admin/security-model/#signing-in',
        code: ['apps/server/src/auth/google.ts'],
        en: {
          name: 'Google',
          title: 'Sign in with Google',
          body: 'For invited people and accounts that linked it. Never open sign-up.',
        },
      },
    ],
  },
  {
    id: 'ai',
    en: 'AI and automation',

    items: [
      {
        id: 'providers',
        icon: 'ai',
        href: '/users/ai-providers/#providers',
        code: ['packages/shared/src/ai.ts', 'apps/server/src/ai/providers.ts'],
        en: {
          name: 'AI providers',
          title: 'AI providers: OpenAI, Anthropic, Google, Groq, OpenRouter',
          body: 'Or any OpenAI-compatible server. Your key, or none.',
        },
      },
      {
        id: 'ollama',
        icon: 'server',
        href: '/admin/ollama/',
        code: ['apps/server/src/ai/providers.ts', 'compose.full.yaml'],
        en: {
          name: 'Ollama',
          title: 'Ollama (local AI)',
          body: 'A local model on your own machine. The ollama profile in compose.full.yaml.',
        },
      },
      {
        id: 'assistant',
        icon: 'robot',
        href: '/users/ai-providers/',
        code: ['apps/server/src/assistant/'],
        en: {
          name: 'Assistant',
          title: 'AI assistant',
          body: 'Ask where something is. Answers cite the things; changes wait for you.',
        },
      },
      {
        id: 'mcp',
        icon: 'mcp',
        href: '/users/mcp-clients/',
        code: ['apps/server/src/mcp/', 'apps/server/src/oauth/', 'packages/mcp/'],
        en: {
          name: 'MCP server',
          body: 'Claude and other AI apps. A personal token or OAuth, limited to the locations you pick.',
        },
      },
      {
        id: 'api',
        icon: 'api',
        href: '/developers/api/',
        code: ['apps/server/src/http/', 'apps/docs/scripts/openapi.ts'],
        en: {
          name: 'HTTP API',
          title: 'HTTP API (OpenAPI)',
          body: 'Documented with OpenAPI. For your own scripts.',
        },
      },
      {
        id: 'home-assistant-app',
        icon: 'server',
        href: '/install/home-assistant/',
        code: ['homeassistant/kept/', 'docker/ha/'],
        en: {
          name: 'Home Assistant app',
          body: "Installs from Home Assistant's app store. In the sidebar, in Home Assistant's backups.",
        },
      },
      {
        id: 'home-assistant',
        icon: 'places',
        href: '/users/home-assistant/',
        // The integration itself is its own repository (kept-homeassistant); this is Kept's side.
        code: ['apps/server/src/home/summary.ts', 'apps/server/src/tokens/access.ts'],
        en: {
          name: 'Home Assistant',
          title: 'Home Assistant integration',
          body: "Overdue, due and expiring per location, each vehicle's next service. Odometer readings sent back.",
        },
      },
      {
        id: 'dashboards',
        icon: 'insights',
        href: '/users/dashboards/',
        code: ['apps/server/src/home/summary.ts'],
        en: {
          name: 'Dashboards',
          title: 'Dashboards: Homepage, Glance, Homarr',
          body: 'What needs you, as a widget. One call, a read-only token.',
        },
      },
      {
        id: 'webhooks',
        icon: 'webhook',
        href: '/users/webhooks/',
        code: ['apps/server/src/notify/webhook.ts', 'apps/server/src/webhooks/'],
        en: {
          name: 'Webhooks',
          body: 'Signed POSTs to your own scripts. Reminders, and changes in a location.',
        },
      },
    ],
  },
  {
    id: 'share-print',
    en: 'Share and print',

    items: [
      {
        id: 'labels',
        icon: 'qrcode',
        href: '/users/everyday-use/#short-ids-and-labels',
        code: [
          'apps/server/src/labels/',
          'apps/server/src/codes/',
          'packages/shared/src/label-stocks.ts',
        ],
        en: {
          name: 'QR labels',
          title: 'Labels and QR codes',
          body: 'A4 sheets, Letter (Avery 5160 layout), label-printer rolls, label-maker tape.',
        },
      },
      {
        id: 'share-links',
        icon: 'share',
        href: '/users/everyday-use/#sharing-a-location',
        code: ['apps/server/src/sharelinks/'],
        en: {
          name: 'Share links',
          title: 'Read-only share links',
          body: 'A box, a room or a search. For someone without an account.',
        },
      },
      {
        id: 'reports',
        icon: 'pdf',
        href: '/users/everyday-use/#reports-the-inventory-insurance-and-claims',
        code: ['apps/server/src/reports/'],
        en: {
          name: 'PDF reports',
          title: 'Inventory and insurance reports (PDF)',
          body: 'Emailed when ready. The inventory weekly or monthly too.',
        },
      },
      {
        id: 'claim-pack',
        icon: 'insurance',
        href: '/users/everyday-use/#reports-the-inventory-insurance-and-claims',
        code: ['apps/server/src/incidents/claim-pack.ts'],
        en: {
          name: 'Claim pack',
          title: 'Insurance claim pack',
          body: 'One ZIP for the insurer: the report, receipts, photos, serials.',
        },
      },
      {
        id: 'export',
        icon: 'backup',
        href: '/users/import-export/#exporting',
        code: ['apps/server/src/exports/'],
        en: {
          name: 'Export',
          title: 'Export a location',
          body: 'A whole location as a ZIP. With a copy you can read without Kept.',
        },
      },
    ],
  },
];

/** Every entry, in the groups' order. */
export const integrations: Integration[] = integrationGroups.flatMap((group) => group.items);

export function groupName(group: IntegrationGroup, _lang: Lang): string {
  return group.en;
}

export function wordsOf(item: Integration, _lang: Lang): Words {
  return item.en;
}
