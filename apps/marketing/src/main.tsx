// input: Browser DOM root and build-time release-note archive
// output: Mounted Storyflow public pages
// pos: Marketing app entrypoint

import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import "./docs.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");

const releaseNotes = document.getElementById("release-notes");
if (!releaseNotes?.textContent) throw new Error("Release notes not found");

createRoot(container).render(
  <React.StrictMode>
    <App releaseNotes={JSON.parse(releaseNotes.textContent)} />
  </React.StrictMode>,
);
