import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { initDraVault } from './store/safeStorage';

/**
 * 先把桌面端加密保险库的数据拉回本源（zustand persist 是同步水合，
 * 依赖读取时数据已就位），再动态 import 挂载应用——保证所有 store 模块
 * 求值发生在保险库就绪之后。初始化失败不阻断启动（降级 localStorage）。
 */
initDraVault()
  .catch(() => undefined)
  .then(() => import('./App'))
  .then(({ default: App }) => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  });
