/** English copy for the documentation site components. */
import type { PathGroup, PathId } from './components/install/paths';
import type { Words } from './i18n';

export const siteSub: Words<string> = {
  en: 'Docs',
};

export interface HeroWords {
  eyebrow: string;
  facts: [string, string, string];
  mapAlt: string;
}

export const hero: Words<HeroWords> = {
  en: {
    eyebrow: 'New: the 3D map',
    facts: ['AGPL-3.0', 'Docker or Kubernetes', 'Offline phone app'],
    mapAlt:
      "Kept's 3D map of a home: its rooms in an isometric view, each labelled, with furniture and boxes, beside the location's tree of places",
  },
};

export interface GalleryWords {
  previous: string;
  next: string;
  of: string;
  pause: string;
  play: string;
}

export const gallery: Words<GalleryWords> = {
  en: {
    previous: 'Previous screen',
    next: 'Next screen',
    of: 'of',
    pause: 'Pause the slideshow',
    play: 'Play the slideshow',
  },
};

export interface IntegrationsWords {
  /** The link on each entry of the integrations page. */
  setUp: string;
  /** The link under the landing page's wall; `count` is the number, already formatted. */
  all: (count: string) => string;
}

export const integrations: Words<IntegrationsWords> = {
  en: {
    setUp: 'Set it up',
    all: (count) => `All ${count} integrations, and how to set each up`,
  },
};

export interface TryKeptWords {
  note: string;
  open: string;
  desktop: string;
  phone: string;
}

export const tryKept: Words<TryKeptWords> = {
  en: {
    note: 'The whole app with a sample household, in your browser. Nothing is saved or sent.',
    open: 'Open Kept',
    desktop:
      "Kept's Home on a desktop: Get started, the Needs you tiles, the locations with their map previews, shortcuts and Insights",
    phone: "Kept's Home on a phone: the Needs you tiles and the shortcuts, above the tab bar",
  },
};

export interface TryMapWords {
  note: string;
  reset: string;
  install: string;
  loading: string;
  failed: string;
  noscript: string;
  /** The text before and after the Poly Haven link. */
  credit: [string, string];
}

export const tryMap: Words<TryMapWords> = {
  en: {
    note: 'A sample home, in your browser. Nothing you change is saved or sent anywhere.',
    reset: 'Reset',
    install: 'Install Kept',
    loading: 'Loading the map…',
    failed: 'The map couldn’t load. Reload the page to try again.',
    noscript: 'The map needs JavaScript.',
    credit: [
      'Furniture, plants, tools and the AC units are free models from ',
      ' (CC0), shrunk for phones. Turn off Detailed models to download none.',
    ],
  },
};

export interface InstallWords {
  /** The picker's name, for screen readers. */
  picker: string;
  /** The picker's two groups. */
  groups: Record<PathGroup, string>;
  /** Each path's name (its chip and its section's heading) and a few words under the name. */
  paths: Record<PathId, { name: string; hint: string }>;
  /** The line before a path's requirements. */
  need: string;
  /** The label of the check after a step. */
  see: string;
}

export const install: Words<InstallWords> = {
  en: {
    picker: 'How you run Kept',
    groups: { terminal: 'In a terminal', oneClick: 'One click' },
    paths: {
      compose: { name: 'Docker Compose', hint: 'One machine' },
      kubernetes: { name: 'Kubernetes', hint: 'With Helm' },
      source: { name: 'From source', hint: 'Your own image' },
      'home-assistant': { name: 'Home Assistant', hint: 'As an app' },
    },
    need: 'What you need',
    see: 'You should see',
  },
};
