import { createRoot } from "react-dom/client";
import { App } from "./app/App";

function loadExternalScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Could not load `));
    document.head.append(script);
  });
}
import "./styles/tokens.css";
import "./styles/room.css";
import "./styles/react.css";

await Promise.all([
  loadExternalScript("/voice-browser/room-i18n.js?v=react-1"),
  loadExternalScript("/voice-browser/room-client.js?v=react-1"),
  loadExternalScript("/voice-browser/stt-client.js?v=react-1"),
]);

createRoot(document.getElementById("root")!).render(<App />);
