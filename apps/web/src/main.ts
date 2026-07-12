import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin } from '@tanstack/vue-query';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import { router } from './router';

createApp(App)
  .use(createPinia())
  .use(router)
  .use(VueQueryPlugin)
  .use(ElementPlus)
  .mount('#app');
