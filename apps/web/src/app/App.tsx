import { RoomProvider } from "./RoomProvider";
import { ErrorBoundary } from "./ErrorBoundary";
import { RoomHeader } from "../features/room/RoomHeader";
import { ParticipantSidebar } from "../features/room/ParticipantSidebar";
import { TranscriptPanel } from "../features/conversation/TranscriptPanel";
import { CallToolbar } from "../features/call/CallToolbar";
import { ConnectionStatsDialog } from "../features/diagnostics/ConnectionStatsDialog";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import { PreparationDialog } from "../features/call/PreparationDialog";
import { TooltipProvider } from "../components/ui/Tooltip";

export function App() {
  return (
    <RoomProvider>
      <TooltipProvider>
        <RoomHeader />
        <main>
          <ErrorBoundary area="participants"><ParticipantSidebar /></ErrorBoundary>
          <ErrorBoundary area="transcript"><TranscriptPanel /></ErrorBoundary>
        </main>
        <ErrorBoundary area="toolbar"><CallToolbar /></ErrorBoundary>
        <ConnectionStatsDialog />
        <SettingsDialog />
        <PreparationDialog />
        <audio id="preview-audio" />
      </TooltipProvider>
    </RoomProvider>
  );
}
