<script setup lang="ts">
defineProps<{
  title: string;
  warnings: string[];
}>();
</script>

<template>
  <section v-if="warnings.length" class="warning-box">
    <h3>{{ title }}</h3>
    <ul class="warning-list">
      <li v-for="(warning, index) in warnings" :key="index">
        {{ warning }}
      </li>
    </ul>
  </section>
</template>
