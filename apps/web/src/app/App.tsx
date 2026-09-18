import { RoomProvider } from "./RoomProvider";
import { RoomHeader } from "../features/room/RoomHeader";
import { ParticipantSidebar } from "../features/room/ParticipantSidebar";
import { TranscriptPanel } from "../features/conversation/TranscriptPanel";
import { CallToolbar } from "../features/call/CallToolbar";
import { ConnectionStatsDialog } from "../features/diagnostics/ConnectionStatsDialog";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import { PreparationDialog } from "../features/call/PreparationDialog";

export function App() {
  return (
    <RoomProvider>
      <RoomHeader />
      <main>
        <ParticipantSidebar />
        <TranscriptPanel />
      </main>
      <CallToolbar />
      <ConnectionStatsDialog />
      <SettingsDialog />
      <PreparationDialog />
      <audio id="preview-audio" />
    </RoomProvider>
  );
}
