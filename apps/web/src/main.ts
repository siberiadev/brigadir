import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin } from '@tanstack/vue-query';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
// Dark-theme --el-* overrides, activated by the `dark` class on <html>
// (managed by useTheme / the pre-hydration script in index.html).
import 'element-plus/theme-chalk/dark/css-vars.css';
// Self-hosted Ubuntu (regular / medium / bold). Each file registers @font-face
// for every subset it ships — including cyrillic — so the browser lazy-loads
// only the ranges it needs. Kept before our global stylesheet.
import '@fontsource/ubuntu/400.css';
import '@fontsource/ubuntu/500.css';
import '@fontsource/ubuntu/700.css';
// Global base styles: normalize + Ubuntu font + --el-font-family override.
// After element-plus CSS so our overrides win by cascade order.
import './styles/main.scss';
import App from './App.vue';
import { router } from './router';

createApp(App)
  .use(createPinia())
  .use(router)
  .use(VueQueryPlugin)
  .use(ElementPlus)
  .mount('#app');
