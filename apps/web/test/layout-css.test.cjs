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
