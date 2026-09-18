import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { Button } from "./components/ui/Button";

function loadExternalScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.append(script);
  });
}
import "./styles/tokens.css";
import "./styles/room.css";
import "./styles/react.css";

const root = createRoot(document.getElementById("root")!);

try {
  await Promise.all([
    loadExternalScript("/voice-browser/room-i18n.js?v=react-1"),
    loadExternalScript("/voice-browser/room-client.js?v=react-1"),
    loadExternalScript("/voice-browser/stt-client.js?v=react-1"),
  ]);
  root.render(<App />);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  root.render(
    <main className="startup-error" role="alert">
      <h1>No se pudo iniciar Sidevoice</h1>
      <p>{message}</p>
      <Button variant="primary" onClick={() => location.reload()}>Reintentar</Button>
    </main>,
  );
}
