import { SettingsIcon } from "../../components/ui/Icons";

export function RoomHeader() {
  return <header><div><h1>Sala de conversaciones</h1><div className="subtitle">Tu espacio para hablar y trabajar</div></div><button id="settings-open" aria-label="Configuración" title="Configuración"><SettingsIcon /></button></header>;
}
