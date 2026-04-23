/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

declare module '*?raw' {
  const content: string;
  export default content;
}

declare module '*.md?html' {
  const html: string;
  export default html;
}
