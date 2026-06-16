<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { locale } = useI18n();

function onChange(event: Event) {
  const next = (event.target as HTMLSelectElement).value;
  if (next !== 'en' && next !== 'zh') return;
  locale.value = next;
  localStorage.setItem('esp-pt-locale', next);
}
</script>

<template>
  <label class="lang-select-wrap" :title="locale === 'en' ? 'Switch language' : '切换语言'">
    <span class="lang-select-icon" aria-hidden="true">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m5 8 6 6" />
        <path d="m4 14 6-6 2-3" />
        <path d="M2 5h12" />
        <path d="M7 2h1" />
        <path d="m22 22-5-10-5 10" />
        <path d="M14 18h6" />
      </svg>
    </span>
    <select class="lang-switch" :value="locale" @change="onChange">
      <option value="en">English</option>
      <option value="zh">中文</option>
    </select>
  </label>
</template>
