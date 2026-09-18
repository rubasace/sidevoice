import { SettingsIcon } from "../../components/ui/Icons";
import { Button } from "../../components/ui/Button";

export function RoomHeader() {
  return <header><div><h1>Sala de conversaciones</h1><div className="subtitle">Tu espacio para hablar y trabajar</div></div><Button id="settings-open" variant="ghost" size="icon" aria-label="Configuración" title="Configuración"><SettingsIcon /></Button></header>;
}
