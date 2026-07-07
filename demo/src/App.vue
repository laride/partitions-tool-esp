<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import LanguageSwitch from './components/LanguageSwitch.vue';

const { t } = useI18n();

const navItems = [
  { path: '/', label: 'README' },
  { path: '/partition-table', labelKey: 'tabs.partitionTable' },
  { path: '/nvs', labelKey: 'tabs.nvs' },
  { path: '/spiffs', labelKey: 'tabs.spiffs' },
  { path: '/fatfs', labelKey: 'tabs.fatfs' },
  { path: '/littlefs', labelKey: 'tabs.littlefs' },
] as const;
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="header-left">
        <router-link to="/" class="title-link">
          <h1 class="title">Partitions Tool (for) ESP</h1>
        </router-link>
        <span class="subtitle">{{ t('subtitle') }}</span>
      </div>
      <div class="header-right">
        <LanguageSwitch />
        <a
          class="header-link npm-link"
          href="https://www.npmjs.com/package/partitions-tool-esp"
          target="_blank"
          rel="noopener"
        >
          <span class="header-link-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" role="img">
              <path
                d="M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z"
                fill="currentColor"
              />
            </svg>
          </span>
          <span>npm</span>
        </a>
        <a
          class="header-link github-link"
          href="https://github.com/laride/partitions-tool-esp"
          target="_blank"
          rel="noopener"
        >
          <span class="header-link-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" role="img">
              <path
                d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.16c-3.34.73-4.04-1.42-4.04-1.42-.55-1.38-1.33-1.75-1.33-1.75-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.22 1.84 1.22 1.08 1.82 2.83 1.3 3.51.99.11-.76.42-1.3.76-1.6-2.67-.3-5.48-1.31-5.48-5.86 0-1.3.47-2.36 1.23-3.2-.12-.3-.53-1.52.12-3.16 0 0 1-.32 3.3 1.22a11.58 11.58 0 0 1 6 0c2.3-1.54 3.3-1.22 3.3-1.22.65 1.64.24 2.86.12 3.16.77.84 1.23 1.9 1.23 3.2 0 4.56-2.82 5.55-5.5 5.85.44.37.82 1.08.82 2.18v3.23c0 .32.21.7.83.58A12 12 0 0 0 12 .5Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <span>GitHub</span>
        </a>
      </div>
    </header>

    <nav class="tabs">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="tab"
        active-class="active"
        :exact="item.path === '/'"
      >
        {{ 'labelKey' in item ? t(item.labelKey) : item.label }}
      </router-link>
    </nav>

    <main class="content">
      <router-view />
    </main>

    <footer class="footer">
      <a
        class="footer-link"
        href="https://github.com/laride/partitions-tool-esp"
        target="_blank"
        rel="noopener"
        >{{ t('footer') }}</a
      >
    </footer>
  </div>
</template>
