import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TitleBar } from "@/components/TitleBar";
import { ToastContainer } from "@/components/Toast";
import Home from "@/pages/Home";
import Settings from "@/pages/Settings";
import PlatformEdit from "@/pages/PlatformEdit";
import PlatformList from "@/pages/PlatformList";
import BatchTest from "@/pages/BatchTest";
import Stats from "@/pages/Stats";
import Proxy from "@/pages/Proxy";
import { useUpdateStore } from "@/store/updateStore";

// 常驻托盘、长时间运行，故除启动外每 6 小时再静默检查一次更新
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function App() {
  useEffect(() => {
    void useUpdateStore.getState().init();
    const timer = setInterval(() => {
      void useUpdateStore.getState().checkForUpdate({ auto: true });
    }, UPDATE_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <BrowserRouter>
      <div className="app-shell h-screen flex flex-col overflow-hidden">
        <TitleBar />
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/platform/list" element={<PlatformList />} />
            <Route path="/platform/new" element={<PlatformEdit />} />
            <Route path="/platform/edit/:id" element={<PlatformEdit />} />
            <Route path="/batch-test" element={<BatchTest />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/proxy" element={<Proxy />} />
          </Routes>
        </main>
        <div id="page-footer-slot" />
        <ToastContainer />
      </div>
    </BrowserRouter>
  );
}

export default App;
