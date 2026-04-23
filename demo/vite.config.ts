import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';
import { copyFileSync, readFileSync } from 'node:fs';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import bash from 'highlight.js/lib/languages/bash';

hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);

const md = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return code;
    },
  }),
);

function markdownPlugin(): Plugin {
  return {
    name: 'md-html',
    transform(_, id) {
      if (!id.endsWith('.md?html')) return;
      const file = id.replace(/\?html$/, '');
      const src = readFileSync(file, 'utf-8');
      const html = md.parse(src, { async: false }) as string;
      return { code: `export default ${JSON.stringify(html)};`, map: null };
    },
  };
}

function spa404Plugin(): Plugin {
  return {
    name: 'spa-404',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');
      copyFileSync(resolve(dist, 'index.html'), resolve(dist, '404.html'));
    },
  };
}

export default defineConfig({
  base: '/partitions-tool-esp/',
  plugins: [markdownPlugin(), vue(), spa404Plugin()],
  resolve: {
    alias: {
      'partitions-tool-esp/partition-table': resolve(__dirname, '../src/partition-table/index.ts'),
      'partitions-tool-esp/nvs': resolve(__dirname, '../src/nvs/index.ts'),
      'partitions-tool-esp/spiffs': resolve(__dirname, '../src/spiffs/index.ts'),
      'partitions-tool-esp/fatfs': resolve(__dirname, '../src/fatfs/index.ts'),
      'partitions-tool-esp/io/browser': resolve(__dirname, '../src/io/browser.ts'),
      'partitions-tool-esp': resolve(__dirname, '../src/index.ts'),
    },
  },
});
