import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig } from '@lingui/conf';
import { lingui, linguiTransformerBabelPreset } from '@lingui/vite-plugin';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const configPath = path('./lingui.config.ts');
const linguiConfig = getConfig({ configPath });

function sourceRevision(): string {
  const options = {
    cwd: path('../..'),
    encoding: 'utf8' as const,
    stdio: ['ignore', 'pipe', 'ignore'] as const,
  };
  try {
    if (execFileSync('git', ['rev-parse', '--show-prefix'], options).trim()) return '';
    if (execFileSync('git', ['status', '--porcelain'], options).trim()) return '';
    return execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
  } catch {
    return '';
  }
}

// The PWA's service worker and browser outbox belong to the web entry point.
export default defineConfig({
  root: path('./native'),
  publicDir: false,
  base: './',
  define: { 'import.meta.env.VITE_SHEEPKEEP_REVISION': JSON.stringify(sourceRevision()) },
  resolve: { alias: { '@': path('./src') } },
  plugins: [
    react(),
    lingui({ configPath }),
    babel({ presets: [linguiTransformerBabelPreset({ linguiConfig }, { configPath })] }),
    tailwindcss(),
  ],
  build: { outDir: path('./dist-ios'), emptyOutDir: true, assetsInlineLimit: 0 },
});
