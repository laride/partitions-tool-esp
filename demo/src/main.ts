import { createApp } from 'vue';
import App from './App.vue';
import { i18n } from './i18n/index.js';
import { router } from './router.js';
import 'highlight.js/styles/github.css';
import './styles/main.css';

const app = createApp(App);
app.use(i18n);
app.use(router);
app.mount('#app');
