import { SettingsIcon, SidevoiceMark } from "../../components/ui/Icons";
import { Button } from "../../components/ui/Button";

/* The name and the mark, and the one control the whole page shares. Nothing that explains itself. */
export function RoomHeader() {
  return <header><h1 className="brand"><SidevoiceMark /> Sidevoice</h1><Button id="settings-open" variant="ghost" size="icon" aria-label="Configuración" title="Configuración"><SettingsIcon /></Button></header>;
}
