import { createRouter, createWebHistory } from 'vue-router';
import ReadmePage from './components/ReadmePage.vue';
import PartitionTableDemo from './components/PartitionTableDemo.vue';
import NvsDemo from './components/NvsDemo.vue';
import SpiffsDemo from './components/SpiffsDemo.vue';
import FatfsDemo from './components/FatfsDemo.vue';
import LittlefsDemo from './components/LittlefsDemo.vue';

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', component: ReadmePage },
    { path: '/partition-table', component: PartitionTableDemo },
    { path: '/nvs', component: NvsDemo },
    { path: '/spiffs', component: SpiffsDemo },
    { path: '/fatfs', component: FatfsDemo },
    { path: '/littlefs', component: LittlefsDemo },
  ],
});
