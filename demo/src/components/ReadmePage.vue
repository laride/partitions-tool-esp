<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import htmlEn from '../../../README.md?html';
import htmlZh from '../../../README_CN.md?html';

const { locale } = useI18n();

const langLinkRe = /<p>\s*<a[^>]*>(?:中文|English)<\/a>\s*<\/p>/;

const html = computed(() => {
  const raw = locale.value === 'zh' ? htmlZh : htmlEn;
  return raw.replace(langLinkRe, '');
});
</script>

<template>
  <article class="readme-content" v-html="html" />
</template>
