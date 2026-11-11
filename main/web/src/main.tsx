import React from "react";
import ReactDOM from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";

import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    {import.meta.env.VITE_ISOLATED !== "true" ? <Analytics /> : null}
    {import.meta.env.VITE_ISOLATED !== "true" ? <SpeedInsights /> : null}
  </React.StrictMode>,
);
