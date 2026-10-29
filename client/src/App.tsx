import { useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { CanvasPage } from './pages/CanvasPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { Landing } from './pages/Landing';
import { SettingsPage } from './pages/SettingsPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { TemplateExpandOverlay } from './components/templates/TemplateExpandOverlay';
import { TitleBar } from './components/TitleBar';
import { ConfirmHost } from './components/ui/Modal';
import { useUiStore } from './store/uiStore';

/**
 * 全局主题同步：订阅 uiStore 的 theme，统一把昼夜状态写到 <html>（暗色无类 /
 * 亮色挂 light）。挂在路由之上，跨页面切换始终生效——各页面不再自行同步，
 * 避免页面卸载时误清主题类（如落地页 → 模板中心后主题回退）。
 */
function ThemeSync() {
  const theme = useUiStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
  }, [theme]);
  return null;
}

function App() {
  return (
    <BrowserRouter>
      <ThemeSync />
      {/* 无边框窗口自绘标题栏（仅 Electron 环境渲染，悬浮右上角） */}
      <TitleBar />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/canvas" element={<CanvasPage />} />
        {/* /chat = 一键创作「生成」对话面板（与 /canvas 共用画布页承载，面板 z-40 实色覆盖） */}
        <Route path="/chat" element={<CanvasPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
      {/* 模板展开过渡层：挂在路由之上跨页不卸载，导航发生在其背后（消除跳转闪帧） */}
      <TemplateExpandOverlay />
      {/* 全局确认弹窗宿主：替代原生 window.confirm（所有页面共用） */}
      <ConfirmHost />
    </BrowserRouter>
  );
}

export default App;
