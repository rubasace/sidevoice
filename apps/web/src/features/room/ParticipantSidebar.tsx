export function ParticipantSidebar() {
  return (
    <aside>
      <h2>Conversaciones</h2>
      <div id="participants" />
      <div className="pairing">
        <button id="pair-connector" type="button">Emparejar conector</button>
        <code id="pair-code" hidden />
        <p className="muted" id="pair-help" hidden>Código válido 10 minutos, un solo uso. En la máquina del agente: <code>sidevoice pair &lt;url de esta sala&gt; CÓDIGO</code></p>
      </div>
    </aside>
  );
}
