const fs=require("node:fs"),test=require("node:test"),assert=require("node:assert/strict");
const css=fs.readFileSync(__dirname+"/../src/styles/react.css","utf8").replace(/\s+/g," ");

test("the chat width is contained at every layout boundary",()=>{
 assert.match(css,/#root > main \{[^}]*max-width: 100%;[^}]*min-width: 0;/);
 assert.match(css,/\.transcript \{[^}]*max-width:100%;min-width:0/);
 assert.match(css,/\.message-viewport-wrap>#messages \{[^}]*max-width:100%;min-width:0;[^}]*overflow-x:hidden/);
 assert.match(css,/\.message-group \{[^}]*max-width:100%;min-width:0/);
 assert.match(css,/\.chat-message-row \{[^}]*max-width:100%;min-width:0/);
 assert.match(css,/\.chat-bubble \{[^}]*min-width:0;[^}]*overflow-wrap:anywhere;word-break:break-word/);
});

test("the mobile grid permits its only column to shrink below message content",()=>{
 assert.match(css,/@media \(max-width: 750px\)[\s\S]*?#root > main \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
});


test("the settings dialog keeps one stable viewport and one scrolling content pane",()=>{
 assert.match(css,/\.settings-dialog\[open\] \{[^}]*grid-template-rows:auto minmax\(0,1fr\) auto;[^}]*height:min\(52rem,calc\(100dvh - 2rem\)\);[^}]*overflow:hidden/);
 assert.match(css,/\.settings-dialog \.settings-content \{[^}]*min-width:0;min-height:0;[^}]*overflow:auto/);
 assert.match(css,/\.settings-dialog \.model-picker \{[^}]*grid-template-columns:minmax\(0,1fr\) 2\.65rem;[^}]*overflow:hidden/);
});

test("settings controls reflow without overflowing on narrow screens",()=>{
 assert.match(css,/@media \(max-width:700px\)[\s\S]*?\.settings-dialog \.settings-nav \{[^}]*overflow-x:auto/);
 assert.match(css,/grid-template-areas:"name name name" "model model model" "voice speed preview"/);
 assert.match(css,/@media \(max-width:430px\)[\s\S]*?grid-template-areas:"name name" "model model" "voice voice" "speed preview"/);
});

test("the recording bubble is the waveform and cancelling sits inside it, on its own line",()=>{
 assert.match(css,/\.voice-wave\{[^}]*display:block/);
 assert.match(css,/\.voice-wave canvas\{[^}]*width:100%;height:100%/);
 assert.match(css,/\.voice-wave\[data-phase=transcribing\] canvas\{[^}]*animation:voice-wave-rest/);
 assert.match(css,/@media \(prefers-reduced-motion:reduce\)\{\.voice-bars i\{animation:none/);
 assert.match(css,/\.cancel-input\{[^}]*display:block;margin:\.3rem 0 0 auto;[^}]*border:0;[^}]*color:#ffb4ab/);
});
