// Service worker: handles the Alt+D "capture-selection" command — grabs the
// selected text on the page, parses it, and saves straight to the local server.
// Feedback via the toolbar badge: ✓ saved, ? nothing selected, ! failed.
'use strict';

const SERVER = 'http://localhost:3210';

function badge(text, tabId, color) {
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch?.(() => {}), 5000);
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'capture-selection') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) return;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['selection.js'],
    });
    const data = results && results[0] ? results[0].result : null;
    if (!data || !data.description) {
      badge('?', tab.id, '#d29922'); // nothing selected
      return;
    }
    const res = await fetch(SERVER + '/api/lands/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    badge(res.ok ? '✓' : '!', tab.id, res.ok ? '#3fb950' : '#f85149');
  } catch (e) {
    badge('!', tab.id, '#f85149');
  }
});
