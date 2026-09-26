import { SettingsIcon, SidevoiceMark } from "../../components/ui/Icons";
import { Button } from "../../components/ui/Button";
import { ConversationTabs } from "./ConversationTabs";

/* The name and the mark, the conversations as tabs on a phone, and the one control the whole page shares. */
export function RoomHeader() {
  return <header><h1 className="brand"><SidevoiceMark /> <span className="brand-name">Sidevoice</span></h1><ConversationTabs /><Button id="settings-open" variant="ghost" size="icon" aria-label="Configuración" title="Configuración"><SettingsIcon /></Button></header>;
}
