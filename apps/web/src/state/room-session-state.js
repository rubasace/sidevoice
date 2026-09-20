// The session's facts and pure projections. No DOM, storage, audio engine or clock reads here.
export const PRESENCE_LEVEL = .1;
export const PRESENCE_DELIVERED_DELAY_MS = 1500;
export const GAP_BUFFER_SECONDS = 30;
// A turn closing is not the same as a person having finished: between one turn and the next there is a
// breath, and the bed used to start in it, over someone who was still talking (2026-09-20).
export const BED_AFTER_USER_MS = 2000;
export const JOIN_STEPS = { audio: 'Preparando audio', whisper: 'Cargando Whisper', voice: 'Cargando el modelo de voz', microphone: 'Pidiendo el micrófono', room: 'Entrando en la sala', conversation: 'Volviendo a ', reconnect: 'Reconectando con la sala…', transcription: 'Cambiando de transcripción…', mic: 'Aplicando los ajustes del micrófono…' };
export const REPLAY_NOTES = { queued: 'Repitiendo lo que no oíste', playing: 'Repitiendo lo que no oíste', done: 'Repetido al volver', cancelled: 'Repetición cancelada', gone: 'No se pudo repetir · la sala ya no tiene ese audio' };
const OUTPUT_MARKS = { ok: '', recovering: ' · audio ↻', failed: ' · audio ✕' };
const OUTPUT_TITLES = { ok: 'Salida de audio en orden', recovering: 'La salida de audio se atascó y se está recuperando', failed: 'La salida de audio falló; revisa las estadísticas' };
export function initialSessionFacts() {
    return {
        ws: null, stream: null, sessionId: null, roomRevision: 0, roomInfo: null, connecting: false, reconnecting: false,
        switching: false, switchingSession: false, switchingTranscription: false, roomBinding: null, viewedThread: null,
        people: [], history: [], roomSeen: {}, replayMarks: {}, inputReceipts: {},
        userLive: false, botLive: false, activeSpeech: null, previewJob: null,
        userTurn: null, pendingPhase: '', pendingUserText: '', cancelledInput: false, textSending: false, micEnabled: true,
        voicePreferences: null, enginePreferences: null, sttRuntime: null, engineReady: false, outputHealth: 'ok', echoFacts: null,
        joinStep: null, joinFailure: '', joinProgress: null, joinDetail: '', joinSubject: '',
        screenLock: { state: '', note: '' }, deviceNote: '', holding: false, userQuietAt: 0, liveNote: '',
        audioDevices: { inputs: [], outputs: [], inputId: 'default', outputId: 'default', available: true, outputAvailable: true, busy: false },
        harness: {}, turns: {}, now: 0, karaokeState: null, bootError: null, languageModels: [],
    };
}
export function selectedThread(s) { return s.roomBinding?.thread_id || null; }
export function viewedThread(s) { return s.viewedThread || selectedThread(s); }
export function speechSegment(speech) { return speech.history_id || speech.session_id + ':voice:' + speech.utterance_id; }
export function working(s, thread = selectedThread(s)) {
    if (!s.ws || !thread)
        return false;
    // false is an authoritative report too. Receipts and replies can never override it.
    if (typeof s.harness[thread] === 'boolean')
        return s.harness[thread];
    return Object.values(s.turns).some(t => t.thread === thread && t.session === s.sessionId && !t.settled &&
        !['not_sent', 'channel_closed'].includes(t.status) &&
        (t.status === 'read' || (['delivered', 'unconfirmed'].includes(t.status) && s.now >= t.readyAt)));
}
/** Whether enough silence has passed since this person last spoke for an ambient sound to be welcome. */
export function userSettled(s) {
    return !s.userQuietAt || s.now >= s.userQuietAt + BED_AFTER_USER_MS;
}
export function sessionStatus(s) {
    const speaker = s.userLive ? 'user' : s.botLive || s.activeSpeech?.started ? 'room' : 'nobody';
    const busy = working(s);
    const tab = s.reconnecting ? 'reconnecting' : s.switching || s.switchingSession || s.switchingTranscription ? 'switching' :
        !s.ws ? 'out' : s.pendingPhase === 'transcribing' ? 'transcribing' : 'listening';
    return { speaker, conversation: busy ? 'working' : speaker === 'room' ? 'speaking' : 'idle', tab,
        selected: selectedThread(s), viewed: viewedThread(s), harness: s.harness[selectedThread(s)] ?? null,
        working: busy, bed: busy && speaker === 'nobody' && userSettled(s) && !s.activeSpeech && !s.previewJob &&
            !s.reconnecting && !s.switching && !s.switchingSession && !s.switchingTranscription && s.voicePreferences?.presence_sound !== 'off' };
}
export function joinView(s) {
    if (s.joinFailure)
        return { step: 'failed', text: s.joinFailure, progress: null, failed: true };
    if (!s.joinStep)
        return null;
    const base = JOIN_STEPS[s.joinStep] + (s.joinStep === 'conversation' ? s.joinSubject : '');
    const note = s.joinProgress != null ? Math.round(s.joinProgress) + ' %' : s.joinDetail;
    return { step: s.joinStep, text: note ? base + ' (' + note + ')' : base, progress: s.joinProgress, failed: false };
}
export function echoCoverage(f) {
    if (!f?.connected || !f.track)
        return { state: '', note: '' };
    if (f.aec === false)
        return { state: 'off', note: 'El micrófono no tiene cancelación de eco: la voz de la sala por el altavoz abrirá intervenciones.' };
    if (f.aec !== true)
        return { state: 'partial', note: 'El navegador no confirma la cancelación de eco del micrófono.' };
    if (f.health && f.health.output !== 'element')
        return { state: 'partial', note: 'La voz no sale por el elemento de audio: en el iPhone no entra en la cancelación de eco.' };
    if (f.health?.element?.paused)
        return { state: 'partial', note: 'La salida de audio está en pausa; se recupera con la siguiente locución.' };
    return { state: 'on', note: 'Cancelación de eco activa y la voz sale por el elemento de audio.' };
}
/** The microphone button: what it says and whether it can be pressed. The level itself is not here —
 *  it changes per animation frame and belongs to whoever owns the meter. */
export function micView(s) {
    const enabled = s.micEnabled !== false;
    const label = enabled ? 'Silenciar micrófono' : 'Activar micrófono';
    // Never disabled: the preference is set before joining as often as during a call, and a button that
    // looks dead right after a reload reads as "the microphone is broken" (2026-09-20).
    return { enabled, label, pressed: !enabled, disabled: false, holding: !!s.holding,
        title: label + ' (⌘D / Ctrl+D). Mantén Espacio para hablar si está silenciado.' };
}
/** The call button: joining and leaving are the same button, and it says which one it is now. */
export function callView(s) {
    const joined = !!(s.ws || s.connecting);
    return { joined, busy: !!(s.reconnecting || s.switchingSession),
        label: joined ? 'Salir de la sala' : 'Entrar en la sala' };
}
/** The name over the transcript: the conversation being looked at, whoever it is. */
export function viewedTitle(s) {
    const id = viewedThread(s);
    if (!id)
        return 'Conversación en directo';
    return s.people.find(p => p.thread_id === id)?.title
        || s.history.find(r => r.thread === id && r.role === 'assistant')?.name
        || s.roomBinding?.title || 'Conversación en directo';
}
export function engineView(s) {
    const base = s.engineReady ? engineBadgeText(s.enginePreferences || s.voicePreferences, s.sttRuntime) : '';
    return { text: base ? base + OUTPUT_MARKS[s.outputHealth] : '', title: base ? base + ' · ' + OUTPUT_TITLES[s.outputHealth] : '', output: s.outputHealth };
}
const VOICE_LABELS = { kokoro: 'Kokoro · en este navegador' };
/** Who is answering: one row per model, and the agent's own when its harness could read it. No row for
 *  anything that is not a choice — how a turn ends is the room's and the same for everyone. */
export function enginePanel(s) {
    const p = s.enginePreferences || s.voicePreferences, runtime = s.sttRuntime, rows = [];
    if (p) {
        const local = String(runtime?.model || p.stt_model || '').split('/').pop().replace('whisper-', 'Whisper ');
        rows.push({ id: 'stt', label: 'Escucha',
            value: p.stt_provider === 'openai' ? 'OpenAI · ' + (p.stt_model || '') : local + ' · en este navegador',
            state: runtime?.fallback_from ? 'warn' : 'ok',
            note: runtime?.fallback_from ? 'La GPU no pudo con el modelo; va por CPU.' : '' });
        const model = String(p.default_model || 'kokoro');
        rows.push({ id: 'tts', label: 'Habla',
            value: VOICE_LABELS[model] || 'ElevenLabs · ' + model.replace(/^eleven_/, '').replace(/_/g, ' '),
            state: 'ok', note: '' });
    }
    const engine = s.people?.find(person => person.thread_id === selectedThread(s))?.engine;
    if (engine?.model)
        rows.push({ id: 'agent', label: 'Piensa',
            value: [engine.model, engine.effort && 'esfuerzo ' + engine.effort].filter(Boolean).join(' · '),
            state: 'ok', note: '' });
    return rows;
}
/** What this call has switched on right now, as lights: the browser's own hardware, echo coverage, the
 *  screen. Facts about the device, not choices, which is why they sit apart from the models. */
export function capabilityPanel(s) {
    const rows = [], runtime = s.sttRuntime, p = s.enginePreferences || s.voicePreferences;
    if (runtime?.device)
        rows.push({ id: 'device', label: runtime.device === 'webgpu' ? 'WebGPU' : 'CPU',
            value: runtime.device === 'webgpu' ? 'La transcripción usa la GPU' : 'La transcripción usa la CPU',
            state: runtime.fallback_from ? 'warn' : 'ok',
            note: runtime.fallback_from ? 'Se pidió GPU y no pudo con el modelo.' : '' });
    else if (p?.stt_provider === 'openai')
        rows.push({ id: 'device', label: 'En la nube', value: 'La transcripción no usa este dispositivo', state: 'ok', note: '' });
    const echo = echoCoverage({ ...s.echoFacts, connected: !!s.ws, track: !!s.stream });
    if (echo.state)
        rows.push({ id: 'echo', label: 'Eco',
            value: echo.state === 'on' ? 'Cancelación activa' : echo.state === 'partial' ? 'Cobertura parcial' : 'Sin cancelación',
            state: echo.state === 'on' ? 'ok' : echo.state === 'partial' ? 'warn' : 'fail', note: echo.note });
    if (s.screenLock?.state)
        rows.push({ id: 'screen', label: 'Pantalla',
            value: s.screenLock.state === 'on' ? 'Se mantiene encendida' : 'No se pudo mantener',
            state: s.screenLock.state === 'on' ? 'ok' : 'warn', note: s.screenLock.note });
    rows.push({ id: 'output', label: 'Salida',
        value: s.outputHealth === 'failed' ? 'El audio falló' : s.outputHealth === 'recovering' ? 'Recuperándose' : 'Audio en orden',
        state: s.outputHealth === 'failed' ? 'fail' : s.outputHealth === 'recovering' ? 'warn' : 'ok',
        note: OUTPUT_TITLES[s.outputHealth] });
    return rows;
}
export function playbackState(r, s) {
    if (r.role !== 'assistant')
        return undefined;
    if (s.activeSpeech && r.segment === speechSegment(s.activeSpeech))
        return s.activeSpeech.started ? 'playing' : 'pending';
    if (['queued', 'synthesizing', 'waiting_for_turn', 'waiting_for_pause'].includes(r.audio))
        return 'pending';
    return r.audio === 'playing' ? 'playing' : 'complete';
}
export function receiptView(status) {
    const symbols = { pending: '◷', sending: '◷', delivered: '✓', unconfirmed: '✓', read: '✓✓', uncertain: '!', not_sent: '!' };
    const labels = { pending: 'Enviando', sending: 'Enviando', delivered: 'Entregado a la conversación; lectura sin confirmar', unconfirmed: 'Escrito en la conversación, sin acuse', read: 'Leído por la conversación', uncertain: 'Entrega sin confirmar', not_sent: 'No enviado' };
    return { symbol: symbols[status] || '', label: labels[status] || '' };
}
export function orderedHistory(s, id) { return s.history.filter(r => r.thread === id).slice().sort((a, b) => Number(!!a.draft) - Number(!!b.draft) || a.time - b.time || (a.seq || 0) - (b.seq || 0)); }
export function unreadCount(s, id) { return s.history.filter(r => r.thread === id && r.role === 'assistant' && r.seq > (s.roomSeen[id] || 0)).length; }
export function conversationView(s) {
    const id = viewedThread(s), own = s.userTurn?.thread === id, activeDraft = own ? s.sessionId + ':' + s.userTurn.key : null;
    const records = orderedHistory(s, id);
    return { messages: records.map(r => ({ ...r, cancellable: !!activeDraft && !s.cancelledInput && r.draft === true && r.segment === activeDraft,
            audioNote: audioNote(r), offlineNote: offlineNote(r), replayNote: r.role === 'assistant' ? REPLAY_NOTES[s.replayMarks[r.segment]] || '' : '',
            playback: playbackState(r, s), karaoke: s.karaokeState?.segment === r.segment ? s.karaokeState : null })),
        pendingText: own ? s.pendingUserText : '', pendingPhase: own && !s.cancelledInput ? s.pendingPhase : '',
        pendingCancellable: own && !s.cancelledInput, working: working(s, id) };
}
export function workingCapabilityNote(p) { const v = p.capabilities?.working; return v === 'supported' ? null : v === 'unsupported' ? 'Este harness no informa cuándo está trabajando; los puntos siguen lo que dice la conversación.' : 'No sabemos si este harness informa cuándo está trabajando.'; }
export function participantsView(s) {
    const selected = selectedThread(s), entries = [...s.people];
    if (selected && !entries.some(p => p.thread_id === selected))
        entries.unshift({ thread_id: selected, title: s.roomBinding.title, available: true });
    return entries.map(p => {
        const unread = unreadCount(s, p.thread_id);
        const reach = p.reach?.state || (p.available ? 'listening' : 'offline');
        const base = reach === 'listening' ? (unread ? unread + ' nuevas' : 'Escuchando') : reach === 'holding' ? 'No puede recibir' : p.available ? 'Sin poder recibir' : 'Desconectada';
        return { threadId: p.thread_id, title: p.title, selected: p.thread_id === selected, available: !!p.available, switching: s.switching,
            unread, reach, stateLabel: unread && reach !== 'listening' ? base + ' · ' + unread + ' nuevas' : base,
            activityNote: workingCapabilityNote(p), detail: p.reach?.detail ? (p.reach.detail + (p.reach.remedy ? '\n\n' + p.reach.remedy : '')) : undefined };
    });
}
export function liveText(s) {
    // A notice the runtime put there (the voice model loading, a saved preference, a server that did not
    // answer) speaks for the moment it belongs to; it is cleared when the call moves on, not overwritten
    // by the next unrelated store change, which is what writing the node used to mean.
    if (s.liveNote)
        return s.liveNote;
    const v = sessionStatus(s);
    if (v.tab === 'reconnecting')
        return 'Reconectando con la sala…';
    if (v.tab === 'switching')
        return 'Cambiando de conversación…';
    if (s.ws && s.stream && s.micEnabled === false)
        return 'Micrófono silenciado';
    if (v.speaker === 'user')
        return 'Te estamos escuchando…';
    if (v.speaker === 'room')
        return 'La conversación está hablando · Puedes interrumpir';
    if (v.tab === 'transcribing')
        return 'Procesando tu intervención…';
    return s.ws ? (v.selected ? 'Puedes hablar. La transcripción aparece al completar tu intervención.' : 'Estás en la sala · Esperando a una conversación') : 'Entra en la sala para hablar.';
}
// A receipt/reply records evidence about its own turn, never an instruction to extinguish a light.
export function recordReceipt(s, id, status, at) {
    const previous = s.turns[id] || {};
    return { ...s.turns, [id]: { ...previous, session: previous.session ?? s.sessionId, thread: previous.thread ?? selectedThread(s), status,
            readyAt: previous.readyAt ?? at + PRESENCE_DELIVERED_DELAY_MS } };
}
export function recordReply(s, d) {
    const id = (d.session_id || s.sessionId) + ':user-turn:' + (d.reply_revision ?? d.revision);
    const previous = s.turns[id] || {};
    return { ...s.turns, [id]: { ...previous, session: d.session_id || s.sessionId, thread: d.thread_id, settled: true } };
}
// A single store is shared by React and the runtime adapter. The writable facade records top-level
// facts; batch() makes a synchronous protocol transition observable only once. Nested records are
// replaced, not mutated. Browser handles are opaque and never persisted or sent to the room.
export function createRoomSessionStore(seed = {}) {
    let facts = { ...initialSessionFacts(), ...seed }, depth = 0, dirty = false;
    const listeners = new Set();
    let snapshot;
    function project() {
        return { facts, session: sessionStatus(facts), conversation: conversationView(facts), participants: participantsView(facts),
            join: joinView(facts), engine: engineView(facts), echo: echoCoverage({ ...facts.echoFacts, connected: !!facts.ws, track: !!facts.stream }), live: liveText(facts),
            mic: micView(facts), call: callView(facts), title: viewedTitle(facts), screenLock: facts.screenLock, deviceNote: facts.deviceNote,
            enginePanel: enginePanel(facts), capabilityPanel: capabilityPanel(facts),
            audioDevices: facts.audioDevices,
            bootError: facts.bootError, languageModels: facts.languageModels };
    }
    function publish() { if (depth || !dirty)
        return; dirty = false; const previous = snapshot; snapshot = project(); for (const listener of listeners)
        listener(snapshot, previous); }
    function patch(values) { if (!Object.entries(values).some(([k, v]) => facts[k] !== v))
        return; facts = { ...facts, ...values }; dirty = true; publish(); }
    snapshot = project();
    const initial = snapshot;
    return {
        facts: new Proxy({}, { get: (_, key) => facts[key], set: (_, key, value) => { patch({ [key]: value }); return true; } }),
        getState: () => snapshot, getInitialState: () => initial, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        patch, batch(fn) { depth++; try {
            return fn();
        }
        finally {
            depth--;
            publish();
        } },
    };
}
export function offlineNote(r) {
    if (r.role !== 'user' || !r.offline)
        return '';
    return r.offline === 'truncated'
        ? 'Capturado sin conexión · solo se guardaron los últimos ' + GAP_BUFFER_SECONDS + ' s'
        : 'Capturado sin conexión';
}
export function audioNote(r) {
    const reasons = { newer_turn: 'Empezaste otra intervención', user_speaking: 'Estabas hablando', focus_changed: 'Cambiaste de conversación', call_ended: 'Llamada desconectada', session_changed: 'La llamada había cambiado', expired_audio_turn: 'El turno de audio había caducado', queue_full: 'Cola de audio llena', user_interrupted: 'Interrumpiste el audio', playback_failed: 'Falló la reproducción', service_restarted: 'Se reinició el servicio', channel_closed: 'Canal de voz cerrado' };
    const reason = reasons[r.audio_reason];
    if (r.audio === 'waiting_for_pause')
        return 'Audio pendiente · Breve pausa antes de hablar';
    if (r.audio === 'waiting_for_turn')
        return 'Audio pendiente · Esperando a que termines de hablar';
    if (r.audio === 'text_only')
        return 'Sin audio' + (reason ? ' · ' + reason : ' · Motivo no registrado');
    if (r.audio === 'interrupted' || r.audio === 'disconnected' || r.interrupted)
        return 'Audio interrumpido' + (reason ? ' · ' + reason : '') + ' · El texto puede incluir partes que no sonaron';
    if (r.audio === 'failed')
        return 'Audio no reproducido · Falló la reproducción';
    return '';
}
export function engineBadgeText(p, runtime) {
    if (!p)
        return '';
    const turn = p.turn_end_mode === 'timer' ? 'silencio ' + String(p.user_speech_timeout ?? 2.5).replace('.', ',') + ' s' : 'smart-turn';
    if (p.stt_provider === 'openai')
        return 'OpenAI · ' + (p.stt_model || '') + ' · ' + turn;
    const model = String(runtime?.model || p.stt_model || '').split('/').pop().replace('whisper-', 'Whisper '), where = runtime?.device === 'webgpu' ? 'GPU' : runtime?.device === 'wasm' ? 'CPU' : '';
    return [model, where + (runtime?.fallback_from ? ' (GPU falló)' : ''), turn].filter(Boolean).join(' · ');
}
