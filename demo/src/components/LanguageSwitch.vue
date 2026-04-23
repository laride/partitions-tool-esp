<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { locale } = useI18n();

function toggle() {
  const next = locale.value === 'en' ? 'zh' : 'en';
  locale.value = next;
  localStorage.setItem('esp-pt-locale', next);
}
</script>

<template>
  <button
    class="lang-switch"
    @click="toggle"
    :title="locale === 'en' ? '切换到中文' : 'Switch to English'"
  >
    {{ locale === 'en' ? '中文' : 'EN' }}
  </button>
</template>
