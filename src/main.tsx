import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// 初始化主题
if (localStorage.getItem("theme") === "dark") {
  document.documentElement.classList.add("dark");
}

// macOS 透明窗口需要由前端裁出圆角；其他平台保持原窗口外观。
if (navigator.userAgent.includes("Mac OS X")) {
  document.body.classList.add("platform-macos");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
