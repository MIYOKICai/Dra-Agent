import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // 共享类型目录：import type { ... } from '@shared/types'
      '@shared': path.resolve(dir, '../shared'),
    },
  },
  server: {
    port: 5173,
    fs: {
      // 允许访问 monorepo 根目录与 ../shared（跨包源码引用）
      allow: [searchForWorkspaceRoot(process.cwd()), path.resolve(dir, '../shared')],
    },
    proxy: {
      // 后端统一网关
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
