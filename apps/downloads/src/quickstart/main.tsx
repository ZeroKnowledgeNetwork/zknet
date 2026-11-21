import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import Quickstart from "./Quickstart.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Quickstart />
  </StrictMode>,
);
