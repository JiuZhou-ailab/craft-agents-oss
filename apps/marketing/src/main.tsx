// input: Browser DOM root
// output: Mounted Storyflow public pages
// pos: Marketing app entrypoint

import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import "./docs.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
