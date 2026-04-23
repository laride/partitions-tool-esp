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
        <a
          class="github-link"
          href="https://github.com/laride/partitions-tool-esp"
          target="_blank"
          rel="noopener"
          >GitHub</a
        >
        <LanguageSwitch />
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
