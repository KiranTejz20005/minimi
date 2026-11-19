import { createRoot } from "react-dom/client";
import "./theme.css";
import "./shell/shell.css";
import "./views/views.css";
import { App } from "./App";
import "./polish.css"; // last, so it wins over component CSS

createRoot(document.getElementById("root")!).render(<App />);
