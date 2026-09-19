import { Component, type ErrorInfo, type PropsWithChildren } from "react";
import { Button } from "../components/ui/Button";

/* React unmounts the whole root when a render throws, and a blank room is the worst thing that can
 * happen to someone who is driving: the call is still up, but nothing on screen says so. The boundary
 * keeps the failure inside one panel, says so out loud, and reports it to the room (#58). */

interface BoundaryState {
  message: string;
}

export class ErrorBoundary extends Component<PropsWithChildren<{ area: string }>, BoundaryState> {
  state: BoundaryState = { message: "" };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    window.sidevoiceReportError?.({
      kind: `render:${this.props.area}`,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? "" : "",
      component: info.componentStack ?? "",
    });
  }

  render() {
    if (!this.state.message) return this.props.children;
    return (
      <div className="panel-error" role="alert">
        <b>Esta parte de la sala falló.</b>
        <span>{this.state.message}</span>
        <Button variant="primary" size="compact" onClick={() => location.reload()}>Recargar</Button>
      </div>
    );
  }
}
