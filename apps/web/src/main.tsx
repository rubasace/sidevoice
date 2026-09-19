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

// Uncaught errors are reported to the room before anything else is loaded: the controller owns the
// socket, so until it exists the reports wait here (#58).
window.sidevoiceClientErrors = [];
function report(kind: string, message: string, stack?: string) {
  const entry = { kind, message, stack: stack ?? "", component: "" };
  if (window.sidevoiceReportError) window.sidevoiceReportError(entry);
  else window.sidevoiceClientErrors?.push(entry);
}
window.addEventListener("error", (event) => report("uncaught", event.message, event.error?.stack));
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { message?: string; stack?: string } | undefined;
  report("unhandled-rejection", String(reason?.message ?? event.reason), reason?.stack);
});

const root = createRoot(document.getElementById("root")!);

declare const __BUILD_ID__: string;
const buildId = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
(window as unknown as { sidevoiceBuildId?: string }).sidevoiceBuildId = buildId;

try {
  await Promise.all([
    loadExternalScript(`/voice-browser/room-i18n.js?v=${buildId}`),
    loadExternalScript(`/voice-browser/room-client.js?v=${buildId}`),
    loadExternalScript(`/voice-browser/stt-client.js?v=${buildId}`),
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
