import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyAppearance, readAppearance } from "./theme";

// Apply the saved (or default Sky + night) appearance before the first paint.
applyAppearance(readAppearance());
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
