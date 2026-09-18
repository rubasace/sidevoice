export function TranscriptPanel() {
  return (
    <section className="transcript">
      <div className="transcript-head"><strong id="transcript-title">Conversación en directo</strong><span className="muted">Transcripción · ambos lados</span></div>
      <div id="messages" role="log" aria-live="polite"><div className="empty"><b>Un lugar para pensar en voz alta.</b><span>Entra en la sala. Aquí aparecerá lo que dices<br />y lo que responde tu conversación.</span></div></div>
      <form id="text-composer" className="text-composer"><textarea id="text-message" rows={2} maxLength={12000} aria-label="Mensaje escrito" placeholder="Escribe un mensaje…" disabled /><button id="text-send" type="submit" disabled aria-label="Enviar mensaje">Enviar</button></form>
      <div id="error" role="alert" />
      <div id="live" role="status">Puedes entrar aunque no haya ninguna conversación.</div>
    </section>
  );
}
