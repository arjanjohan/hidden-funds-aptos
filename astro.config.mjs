import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

export default defineConfig({
  srcDir: './src/web',
  outDir: './dist',
  output: 'static',
  integrations: [react()],
});
